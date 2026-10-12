# Build context is the repo root: the hub bundles two workspace packages and
# cross-compiles the Go agent so the fleet can update itself off this image.
#
# The agent binaries ship inside the hub for one reason: a hub that knows which
# version it wants but has no copy of it turns every agent update into a manual
# build-upload-curl. Here `docker compose up -d --build hub` is the whole
# release, and the boxes converge on their own.
FROM golang:1.23-alpine AS agent
WORKDIR /src
COPY agent/go.mod agent/go.sum ./
RUN go mod download
COPY agent ./
COPY VERSION /VERSION
# VERSION holds one key=value line per deployable; the agent's is the one that
# gets stamped into the binaries. /out/VERSION is deliberately just the number:
# it is what the hub hands the fleet as its target, and a box compares it as a
# plain string.
RUN set -e; \
    v=$(awk -F= '/^agent=/ { print $2 }' /VERSION); \
    test -n "$v" || { echo "no agent= line in VERSION"; exit 1; }; \
    CGO_ENABLED=0 GOOS=linux GOARCH=arm64 \
      go build -trimpath -ldflags "-s -w -X main.version=$v" \
      -o /out/magnemite-agent-linux-arm64 ./cmd/magnemite-agent; \
    CGO_ENABLED=0 GOOS=linux GOARCH=arm GOARM=7 \
      go build -trimpath -ldflags "-s -w -X main.version=$v" \
      -o /out/magnemite-agent-linux-arm ./cmd/magnemite-agent; \
    printf '%s\n' "$v" > /out/VERSION

# The bootstrap script ships beside the binaries, because the hub pushes both
# over one SSH connection when it provisions a machine. Deliberately not
# downloaded by the machine: it would need a token to fetch anything, and at
# that point it has none.
COPY agent/host/bootstrap.sh /out/bootstrap.sh

FROM node:22-alpine AS build
# pnpm is baked into the image below with `corepack install`: with only
# `corepack enable`, the first pnpm call in a fresh container downloads the
# tarball from the npm registry, which prints a prompt warning and puts the
# registry on the path of every container start.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable && apk add --no-cache openssl
WORKDIR /app

# Which Prisma connector to generate the client for: "postgresql" (default) or
# "mysql", which also covers MariaDB. The Prisma Client baked in here has to
# match the DATABASE_URL the container gets at runtime, so
# deploy/compose.mariadb.yml passes this as a build arg.
ARG DB_PROVIDER=postgresql
ENV DB_PROVIDER=${DB_PROVIDER}

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
# `packageManager` in package.json pins the version.
RUN corepack install
COPY packages ./packages
COPY apps/hub ./apps/hub

RUN pnpm install --frozen-lockfile
RUN pnpm --filter @magnemite/db generate
RUN pnpm --filter @magnemite/hub build

FROM node:22-alpine AS runtime
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable && apk add --no-cache openssl
WORKDIR /app
ENV NODE_ENV=production

# Dev dependencies come along on purpose: the entrypoint runs
# `prisma migrate deploy`, which needs the Prisma CLI at runtime.
COPY --from=build /app ./
# `packageManager` in the copied package.json pins the version.
RUN corepack install
# What the hub hands out as the agent's target version, with the VERSION file
# it was built from next to it. AGENT_BIN_DIR points here.
COPY --from=agent /out /app/agent-bin
# The same release, where the hub itself can read it for the Status page.
COPY VERSION /app/VERSION
COPY apps/hub/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 3001
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "apps/hub/dist/index.js"]
