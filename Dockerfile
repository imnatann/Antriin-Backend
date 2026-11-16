FROM node:24-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig*.json nest-cli.json ./
COPY src ./src
RUN npm run build

# Migration target: drizzle-kit is a devDependency, so it needs the build stage
# (full node_modules) plus the committed migration folder and config.
FROM build AS migrator
COPY drizzle ./drizzle
COPY drizzle.config.ts ./
CMD ["npx", "drizzle-kit", "migrate"]

FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
# Uploaded images live here (MEDIA_ROOT defaults to ./storage/media). The
# directory must exist and belong to the runtime user: the process runs as
# `node`, /app is owned by root, so a missing directory makes the first
# mkdir fail and takes the whole API down at boot.
RUN mkdir -p /app/storage/media && chown -R node:node /app/storage
USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]
