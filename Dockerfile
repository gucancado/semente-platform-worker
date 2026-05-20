FROM node:24-slim AS deps
WORKDIR /app
COPY package.json ./
RUN npm install -g pnpm@10 \
    && pnpm install --prod=false

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
COPY package.json ./
RUN pnpm install --prod
COPY --from=build /app/dist ./dist
COPY migrations ./migrations

EXPOSE 3000
CMD ["node", "dist/index.js"]
