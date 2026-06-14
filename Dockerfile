# KITmate server
# better-sqlite3 のネイティブビルドに python3/make/g++ が必要なため builder ステージで導入する

FROM node:22-slim AS builder
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build \
  && npm prune --omit=dev

FROM node:22-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8787
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY package.json ./
# データ (courses.json / requirements.json / kitmate.db) は /app/data に volume マウントする
RUN mkdir -p /app/data
EXPOSE 8787
CMD ["node", "dist/index.js"]
