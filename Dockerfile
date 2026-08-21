# PLAN §10.1 — multi-stage image.
#
# NOT Alpine: better-sqlite3 has no musl prebuilds, so Alpine forces a fragile
# source build. bookworm-slim (glibc) is the reliable base.
#
# The runtime layer bakes in every native dump/restore tool (§7.2), so tool
# detection always succeeds instead of degrading to the built-in engine.

# ---------------------------------------------------------------------------
FROM node:26-bookworm-slim AS deps
WORKDIR /app
# Build toolchain for native modules (better-sqlite3). Removed with the stage.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund

# ---------------------------------------------------------------------------
FROM deps AS build
WORKDIR /app
COPY . .
RUN npm run build

# ---------------------------------------------------------------------------
FROM node:26-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    DBADMIN_HOME=/data/app \
    PORT=3456 \
    HOST=0.0.0.0

# Native CLI tools (§7.2). Multiple Postgres majors because pg_dump must be >=
# the server it dumps; the transfer layer picks the right binary per connection.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl gnupg openssh-client gzip \
      default-mysql-client \
      redis-tools \
      sqlite3 \
    && install -d /usr/share/postgresql-common/pgdg \
    && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
         -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
    && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" \
         > /etc/apt/sources.list.d/pgdg.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends postgresql-client-16 postgresql-client-17 \
    && rm -rf /var/lib/apt/lists/*

# MongoDB database tools (mongodump/mongorestore), §7.2.
# MongoDB publishes no debian12 arm64 build and its Debian apt repo has no
# arm64 packages, so arm64 takes the Ubuntu 22.04 build — these are Go binaries
# and jammy's glibc (2.35) is older than bookworm's (2.36), so it links fine.
# Best-effort: if the download fails the image still works, falling back to the
# built-in streaming engine.
RUN set -eux; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in \
      amd64) MDB_BUILD=debian12-x86_64 ;; \
      arm64) MDB_BUILD=ubuntu2204-arm64 ;; \
      *)     MDB_BUILD="" ;; \
    esac; \
    if [ -n "$MDB_BUILD" ]; then \
      ( curl -fsSL -o /tmp/mdbtools.tgz \
          "https://fastdl.mongodb.org/tools/db/mongodb-database-tools-${MDB_BUILD}-100.10.0.tgz" \
        && tar -xzf /tmp/mdbtools.tgz -C /tmp \
        && cp /tmp/mongodb-database-tools-*/bin/* /usr/local/bin/ \
        && rm -rf /tmp/mdbtools.tgz /tmp/mongodb-database-tools-* \
        && mongodump --version >/dev/null ) \
      || echo "mongodb-database-tools unavailable; the built-in engine will be used"; \
    fi

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/next.config.mjs ./next.config.mjs
COPY --from=build /app/server.ts ./server.ts
COPY --from=build /app/src ./src
COPY --from=build /app/tsconfig.json ./tsconfig.json

# Mount points: app DB, user SQLite files, export destination.
RUN install -d -o node -g node /data/app /data/sqlite /data/exports
VOLUME ["/data/app"]

USER node
EXPOSE 3456

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3456)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npm", "run", "start"]
