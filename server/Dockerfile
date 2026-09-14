# The whole game in one container: the arena server, which also serves the
# built page. Build from the REPOSITORY ROOT, not from server/:
#
#   docker build -f server/Dockerfile -t flypit .
#   docker run -p 8790:8790 -v flypit-data:/data -e CHAIN=off -e DEV_FAUCET=true flypit
#
# The root is the context because the server imports the shared simulation
# from ../web/src/shared by relative path (one world, not two), and because
# the page is built here too so the two can never drift apart.

# ── 1. The page: a static export of web/ ─────────────────────────────────
FROM node:24-alpine AS page
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
# Left empty on purpose: a page with no configured server talks to the
# origin it was served from, which is this very container. Set it only when
# the page is hosted elsewhere (Vercel) and must find the arena.
ARG NEXT_PUBLIC_FLYPIT_SERVER=
ARG NEXT_PUBLIC_FLYPIT_ARENA=
ARG NEXT_PUBLIC_FLYPIT_TOKEN=
ARG NEXT_PUBLIC_FLYPIT_URL=
ENV NEXT_PUBLIC_FLYPIT_SERVER=$NEXT_PUBLIC_FLYPIT_SERVER \
    NEXT_PUBLIC_FLYPIT_ARENA=$NEXT_PUBLIC_FLYPIT_ARENA \
    NEXT_PUBLIC_FLYPIT_TOKEN=$NEXT_PUBLIC_FLYPIT_TOKEN \
    NEXT_PUBLIC_FLYPIT_URL=$NEXT_PUBLIC_FLYPIT_URL
RUN npm run build

# ── 2. The arena, with the page next to it ───────────────────────────────
FROM node:24-alpine
WORKDIR /app

# The shared simulation the server runs (rules, sim, protocol, names, geometry).
COPY web/src/shared ./web/src/shared
# The page, ready to serve.
COPY --from=page /app/web/out ./web/out

# Server dependencies first, so a code change does not reinstall them.
COPY server/package.json server/package-lock.json ./server/
RUN cd server && npm ci --omit=dev --no-audit --no-fund

COPY server/src ./server/src
COPY server/tsconfig.json ./server/

WORKDIR /app/server

# The ledger lives on a volume: mount /data or every restart starts from zero.
ENV NODE_ENV=production \
    PORT=8790 \
    DB_PATH=/data/flypit.sqlite \
    STATIC_DIR=/app/web/out
VOLUME ["/data"]
EXPOSE 8790

CMD ["npx", "tsx", "src/index.ts"]
