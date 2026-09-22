FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
RUN mkdir -p data
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "src/server.js"]
