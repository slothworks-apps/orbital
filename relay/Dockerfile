FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY relay/package.json relay/
RUN npm ci --workspace shared --workspace relay --include-workspace-root=false
COPY shared shared
COPY relay relay
RUN npm run build -w relay

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production RELAY_PORT=4840 RELAY_DATA_DIR=/data
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/relay/dist relay/dist
VOLUME /data
EXPOSE 4840
CMD ["node", "relay/dist/index.mjs"]
