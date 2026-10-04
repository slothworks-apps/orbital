FROM node:26-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY relay/package.json relay/
# better-sqlite3 ships its prebuilt binaries; without --ignore-scripts npm
# still runs node-gyp for it, which needs a compiler toolchain this image lacks.
RUN npm ci --workspace shared --workspace relay --include-workspace-root=false --ignore-scripts
COPY shared shared
COPY relay relay
RUN npm run build -w relay

FROM node:26-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production RELAY_PORT=4840 RELAY_DATA_DIR=/data
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/relay/dist relay/dist
VOLUME /data
EXPOSE 4840
CMD ["node", "relay/dist/index.mjs"]
