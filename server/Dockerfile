# The arena server. Build from the REPOSITORY ROOT, not from server/:
#
#   docker build -f server/Dockerfile -t flypit-arena .
#   docker run -p 8790:8790 -v flypit-data:/data -e CHAIN=off flypit-arena
#
# It needs the root as context because the server imports the shared
# simulation from ../web/src/shared by relative path: one world, not two.
FROM node:24-alpine

WORKDIR /app

# The shared simulation the server runs (rules, sim, protocol, names, geometry).
COPY web/src/shared ./web/src/shared

# Server dependencies first, so a code change does not reinstall them.
COPY server/package.json server/package-lock.json ./server/
RUN cd server && npm ci --omit=dev --no-audit --no-fund

COPY server/src ./server/src
COPY server/tsconfig.json ./server/

WORKDIR /app/server

# The ledger lives on a volume: mount /data or every restart starts from zero.
ENV NODE_ENV=production \
    PORT=8790 \
    DB_PATH=/data/flypit.sqlite
VOLUME ["/data"]
EXPOSE 8790

CMD ["npx", "tsx", "src/index.ts"]
