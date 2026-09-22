#!/usr/bin/env python3
"""Push a local directory as the initial commit of an empty GitHub repo,
using the GitHub git-database REST API (no git credentials needed).

Usage: push_via_api.py <local_dir> <owner> <repo> <branch> <commit_message>
Skips: .git, node_modules, data/, .env

On a branch that already exists, the new commit gets the current tip as parent.
On a brand-new repo/branch, pass --init to create the first root commit
(if the repo is totally empty, seed one file via the web UI or the
contents API first — the git-database API 409s on empty repos).
"""
import base64
import json
import os
import sys
import urllib.request

sys.path.insert(0, "/opt/hatch/skills/skill-creator/bin")
import dynamic_credentials as dc

ALLOWED_HOSTS = ["api.github.com"]
BASE = "https://api.github.com"
CREDENTIAL_NAME = "custom.github"

SKIP_DIRS = {".git", "node_modules", "data"}
SKIP_FILES = {".env"}


def api(method, path, data=None):
    req = urllib.request.Request(BASE + path, method=method,
                                 data=json.dumps(data).encode() if data is not None else None)
    req.add_header("Accept", "application/vnd.github+json")
    req.add_header("X-GitHub-Api-Version", "2022-11-28")
    req.add_header("User-Agent", "hatch-github-skill")
    if data is not None:
        req.add_header("Content-Type", "application/json")
    dc.add_surrogate_to_request(req, CREDENTIAL_NAME, entry_name="access_token",
                                allowed_hosts=ALLOWED_HOSTS)
    try:
        with urllib.request.urlopen(req) as resp:
            return dc.read_json_response(resp)
    except urllib.error.HTTPError as exc:
        body = exc.read().decode()[:500]
        raise RuntimeError(f"{method} {path} -> {exc.code}: {body}")


def collect_files(root):
    out = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        for fn in filenames:
            if fn in SKIP_FILES:
                continue
            full = os.path.join(dirpath, fn)
            rel = os.path.relpath(full, root)
            out.append((rel, full))
    return sorted(out)


def main():
    args = sys.argv[1:]
    init = "--init" in args
    args = [a for a in args if a != "--init"]
    root, owner, repo, branch, message = args[0:5]
    files = collect_files(root)
    print(f"uploading {len(files)} files...", flush=True)

    parent = None
    if not init:
        try:
            ref = api("GET", f"/repos/{owner}/{repo}/git/refs/heads/{branch}")
            parent = ref["object"]["sha"]
            print(f"parent: {parent[:8]}", flush=True)
        except RuntimeError as exc:
            print(f"no existing ref ({exc}); creating root commit", flush=True)

    tree = []
    for i, (rel, full) in enumerate(files, 1):
        with open(full, "rb") as fh:
            content = base64.b64encode(fh.read()).decode()
        blob = api("POST", f"/repos/{owner}/{repo}/git/blobs",
                   {"content": content, "encoding": "base64"})
        tree.append({"path": rel, "mode": "100644", "type": "blob", "sha": blob["sha"]})
        if i % 8 == 0 or i == len(files):
            print(f"  {i}/{len(files)} blobs", flush=True)

    tree_resp = api("POST", f"/repos/{owner}/{repo}/git/trees", {"tree": tree})
    print("tree:", tree_resp["sha"][:8], flush=True)
    commit_data = {"message": message, "tree": tree_resp["sha"]}
    if parent:
        commit_data["parents"] = [parent]
    commit = api("POST", f"/repos/{owner}/{repo}/git/commits", commit_data)
    print("commit:", commit["sha"], flush=True)
    if parent:
        ref = api("PATCH", f"/repos/{owner}/{repo}/git/refs/heads/{branch}",
                  {"sha": commit["sha"]})
    else:
        try:
            ref = api("POST", f"/repos/{owner}/{repo}/git/refs",
                      {"ref": f"refs/heads/{branch}", "sha": commit["sha"]})
        except RuntimeError:
            ref = api("PATCH", f"/repos/{owner}/{repo}/git/refs/heads/{branch}",
                      {"sha": commit["sha"], "force": True})
    print("ref:", ref["ref"], "->", ref["object"]["sha"][:8], flush=True)
    print("PUSHED", commit["sha"])


if __name__ == "__main__":
    main()
