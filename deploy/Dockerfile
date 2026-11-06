FROM node:24.22.1-alpine AS deps
WORKDIR /repo
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Runtime is plain alpine + the node binary from node:24.22.1-alpine (drops npm/yarn/corepack),
# like the sibling projects (Recipe, mikromagi.dk, SharedLogin, BudgetApp).
FROM node:24.22.1-alpine AS node-bin

FROM alpine:3.24 AS runtime
RUN apk add --no-cache tini libstdc++ \
 && addgroup -g 10001 app && adduser -D -u 10001 -G app app
COPY --from=node-bin /usr/local/bin/node /usr/local/bin/node
WORKDIR /app
COPY --from=deps --chown=app:app /repo/node_modules /app/node_modules
COPY --chown=app:app package.json server.js /app/
COPY --chown=app:app public /app/public
# The Spotify tokens live here; on the NAS it is the named volume "tokens".
RUN mkdir -p /app/data && chown app:app /app/data
ARG APP_VERSION=dev
ENV NODE_ENV=production PORT=5011 TOKENS_FILE=/app/data/tokens.json APP_VERSION=${APP_VERSION}
USER app
EXPOSE 5011
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s CMD wget -qO- http://127.0.0.1:5011/api/health || exit 1
ENTRYPOINT ["/sbin/tini","--"]
CMD ["node","/app/server.js"]
