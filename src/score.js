// Taste Score: explainable 0–100 score. Illustrative only — never a percentile rank.
function computeTasteScore(artists) {
  const list = Array.isArray(artists) ? artists : [];
  const n = list.length;
  if (n === 0) {
    return { score: 0, obscurityPct: 0, genreCount: 0, artistCount: 0, breakdown: 'No artists scanned yet.' };
  }
  // 50% obscurity: share of library artists with popularity below 40
  const obscure = list.filter((a) => (a.popularity ?? 50) < 40).length;
  const obscurity = obscure / n;
  // 30% diversity: unique genres, log-scaled, capped at 60 genres
  const genres = new Set();
  list.forEach((a) => (a.genres || []).forEach((g) => genres.add(g)));
  const diversity = Math.min(1, Math.log(genres.size + 1) / Math.log(61));
  // 20% depth: unique artists, log-scaled, capped at 500 artists
  const depth = Math.min(1, Math.log(n + 1) / Math.log(501));

  const score = Math.round(100 * (0.5 * obscurity + 0.3 * diversity + 0.2 * depth));
  return {
    score: Math.max(0, Math.min(100, score)),
    obscurityPct: Math.round(obscurity * 100),
    genreCount: genres.size,
    artistCount: n,
    breakdown:
      `50% obscurity (${Math.round(obscurity * 100)}% of your artists sit below 40 popularity) + ` +
      `30% diversity (${genres.size} distinct genres) + 20% depth (${n} artists scanned). ` +
      `Illustrative score, not a ranking.`,
  };
}

module.exports = { computeTasteScore };
