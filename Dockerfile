FROM node:24-slim AS deps
WORKDIR /app
# Lockfile no build: sem ele cada deploy resolve deps do zero e drift de
# transitivas quebra o build (ex.: google-auth-library 10.5 vs 10.7, 2026-06-11).
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN npm install -g pnpm@10 \
    && pnpm install --frozen-lockfile --prod=false

FROM node:24-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm install -g pnpm@10 \
    && pnpm build

FROM node:24-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN npm install -g pnpm@10
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod
COPY --from=build /app/dist ./dist
COPY migrations ./migrations

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Migrations rodam no startup (idempotente — _migrations table dedupe).
CMD ["sh", "-c", "node dist/migrate.js && node dist/index.js"]
