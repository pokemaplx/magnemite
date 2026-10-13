# Linux/macOS counterpart of scripts/build-agent.ps1. Everything Go-related
# runs inside the golang image, so no toolchain is needed on the host.

# Single source of truth for versions: the VERSION file at the repo root, which
# holds one `key=value` line per deployable. Everything here is the agent's,
# since the agent is all this Makefile builds. scripts/build-agent.ps1 reads the
# same file, and both stamp it into module.prop at package time, so nothing is
# edited in two places.
VERSION     ?= $(shell awk -F= '/^agent=/ { print $$2 }' VERSION)
# Magisk compares versionCode, not the string. Derived so it always moves with
# the version: 0.1.2 -> 102.
VERSIONCODE := $(shell echo "$(VERSION)" | awk -F. '{ print $$1 * 10000 + $$2 * 100 + $$3 }')
GO_IMAGE    ?= golang:1.23-alpine
# The compose files live under deploy/, so every target names one rather than
# relying on a docker-compose.yml in the working directory. --env-file too:
# Compose looks for .env next to the compose file, and this project's lives at
# the repo root, where everything else reads it from.
#
# The self-hosted stack. It runs no database of its own: DATABASE_URL in .env
# points at one you already run, of either engine.
COMPOSE_FILE ?= deploy/docker-compose.yml
COMPOSE     := docker compose --env-file .env -f $(COMPOSE_FILE)
ROOT        := $(shell pwd)
LDFLAGS     := -s -w -X main.version=$(VERSION)
DOCKER_GO   := docker run --rm -v "$(ROOT)/agent":/src -w /src $(GO_IMAGE)

# Bake an enrollment config into the module zip:
#   make module SERVER=https://magnemite.example.com TOKEN=abc123
SERVER ?=
TOKEN  ?=

.PHONY: help
help:
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'

.PHONY: agent
agent: ## Cross-compile the agent for arm64, arm, amd64 and windows
	$(DOCKER_GO) sh -c '\
		set -e; mkdir -p bin; \
		CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -trimpath -ldflags "$(LDFLAGS)" -o bin/magnemite-agent-linux-arm64 ./cmd/magnemite-agent; \
		CGO_ENABLED=0 GOOS=linux GOARCH=arm GOARM=7 go build -trimpath -ldflags "$(LDFLAGS)" -o bin/magnemite-agent-linux-arm ./cmd/magnemite-agent; \
		CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags "$(LDFLAGS)" -o bin/magnemite-agent-linux-amd64 ./cmd/magnemite-agent; \
		CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build -trimpath -ldflags "$(LDFLAGS)" -o bin/magnemite-agent-windows-amd64.exe ./cmd/magnemite-agent; \
		ls -la bin'

.PHONY: agent-test
agent-test: ## Vet and test the agent
	$(DOCKER_GO) sh -c 'go vet ./... && go test ./...'

.PHONY: module
module: agent ## Package the Magisk module zip into dist/
	@rm -rf dist/module && mkdir -p dist/module/bin
	@cp agent/magisk/* dist/module/
	@cp agent/bin/magnemite-agent-linux-arm64 dist/module/bin/
	@cp agent/bin/magnemite-agent-linux-arm dist/module/bin/
	@sed -i.bak -e 's/^version=.*/version=v$(VERSION)/' -e 's/^versionCode=.*/versionCode=$(VERSIONCODE)/' dist/module/module.prop && rm -f dist/module/module.prop.bak
	@if [ -n "$(SERVER)" ] && [ -n "$(TOKEN)" ]; then \
		printf '{\n  "serverUrl": "%s",\n  "enrollmentToken": "%s"\n}\n' "$(SERVER)" "$(TOKEN)" > dist/module/config.json; \
		echo "  baked enrollment config for $(SERVER)"; \
	elif [ -n "$(SERVER)$(TOKEN)" ]; then \
		echo "SERVER and TOKEN must be set together"; exit 1; \
	fi
	@docker run --rm -v "$(ROOT)/dist":/work -w /work alpine sh -c \
		"apk add --no-cache zip >/dev/null && cd module && zip -r ../magnemite-agent-$(VERSION).zip . -x '.*'"
	@rm -rf dist/module
	@echo "Module: dist/magnemite-agent-$(VERSION).zip"

# Redroid boxes: Android in a container instead of on a shelf. The image is the
# install, so unlike the Magisk zip it takes no SERVER or TOKEN — those are
# properties on the docker command line, and the image stays free of secrets.
#
# Magisk-prerooted, because Cosmog needs it. `_arm` in that tag is the *host*
# architecture, not a 32-bit guest: the image is linux/arm64, which is why the
# Dockerfile copies the arm64 agent and the arm64-only policy still holds.
# 64-bit only, which is what lets a container boot on a CPU without AArch32 --
# Apple Silicon and Graviton 4 upwards. The Dockerfile says why at length, and
# the 64only variants start at Android 12.
REDROID_BASE ?= redroid/redroid:12.0.0_64only-latest
# Versioned by what is *in* the image -- the base, the start script, the .rc --
# and deliberately not by the agent version.
#
# The agent inside is only a seed that the box's own self-update replaces, so
# tying the tag to it would move the tag on every agent release, change the
# rendered `image:` line, and make compose recreate every container on the
# machine: a full Android cold boot each, to deliver a binary the containers
# would have swapped in seconds with a syscall.Exec.
# Which Magisk the image takes its busybox from. Pinned rather than latest,
# because it is a binary that runs as root on every box, and the one that is
# pinned is the one that was proven on a machine.
MAGISK_VERSION ?= v30.7
REDROID_VERSION ?= $(shell awk -F= '/^redroid=/ { print $$2 }' VERSION)
REDROID_TAG     ?= magnemite/redroid:$(REDROID_VERSION)

.PHONY: redroid
redroid: agent ## Build the Redroid image with the agent baked in (arm64 host)
	docker build -f agent/redroid/Dockerfile --build-arg REDROID=$(REDROID_BASE) \
		--build-arg MAGISK=$(MAGISK_VERSION) -t $(REDROID_TAG) agent
	@echo "Image: $(REDROID_TAG)"

# Narrow every compose target to one service: `make build up SERVICE=web`
# rebuilds and restarts the dashboard alone, leaving the hub -- and the device
# sockets it holds -- untouched.
SERVICE ?=

.PHONY: build
build: ## Rebuild the images, or one service with SERVICE=web
	$(COMPOSE) build $(SERVICE)

.PHONY: up
up: ## Start the stack, or one service with SERVICE=web. Builds only what is missing
	$(COMPOSE) up -d $(SERVICE)

.PHONY: down
down: ## Stop the stack
	$(COMPOSE) down

.PHONY: logs
logs: ## Follow hub and web logs
	$(COMPOSE) logs -f hub web

.PHONY: migrate
migrate: ## Apply database migrations inside the hub container
	$(COMPOSE) exec hub pnpm --filter @magnemite/db run deploy

.PHONY: seed
seed: ## Optional: starter app target, sources, device group, first enrollment token
	$(COMPOSE) exec hub pnpm --filter @magnemite/db run seed

.PHONY: typecheck
typecheck: ## Typecheck hub and web
	pnpm --filter @magnemite/hub typecheck && pnpm --filter @magnemite/web typecheck
