# ---- Etapa 1: dependencias ----
FROM node:22-slim AS deps
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# ---- Etapa 2: runtime ----
FROM node:22-slim AS runtime
ENV NODE_ENV=production \
    TZ=America/Asuncion \
    PORT=3000 \
    DATA_DIR=/app/data
# pg_dump se usa para los backups y debe coincidir con la versión del servidor
# (postgres:16). El cliente de Debian bookworm es 15, así que se instala el 16
# desde el repo oficial de PostgreSQL. Con pg (y sin better-sqlite3) ya no hace
# falta toolchain de compilación en la imagen.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tzdata ca-certificates curl gnupg2 \
 && ( \
      curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc | gpg --dearmor --yes -o /usr/share/keyrings/pgdg.gpg \
      && echo "deb [signed-by=/usr/share/keyrings/pgdg.gpg] http://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" > /etc/apt/sources.list.d/pgdg.list \
      && apt-get update \
      && apt-get install -y --no-install-recommends postgresql-client-16 \
    ) || ( \
      rm -f /etc/apt/sources.list.d/pgdg.list \
      && apt-get update \
      && apt-get install -y --no-install-recommends postgresql-client \
    ) \
 && apt-get purge -y --auto-remove curl gnupg2 \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /app/data \
 && chown -R node:node /app/data
WORKDIR /app
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json server.js ./
COPY --chown=node:node lib ./lib
COPY --chown=node:node db ./db
COPY --chown=node:node services ./services
COPY --chown=node:node public ./public
USER node
EXPOSE 3000
VOLUME ["/app/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
