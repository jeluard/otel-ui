# ── OTel UI — Makefile ────────────────────────────────────────────────────
# Targets:
#   make dev-all     Run backend + frontend natively
#   make docker-push Push bridge image to ghcr.io
#   make clean       Remove build artefacts
#   make help        Show this help

# ── Configuration ─────────────────────────────────────────────────────────────

# Port the backend WebSocket listens on
BACKEND_PORT      ?= 8081

# Frontend dev server port
FRONTEND_DEV_PORT ?= 8080

# GitHub username / org — inferred from the git remote, or override explicitly
GHCR_USER    ?= $(shell git remote get-url origin 2>/dev/null | sed 's|.*github\.com[:/]\([^/]*\)/.*|\1|')
BRIDGE_TAG   ?= latest
# Docker bridge image shown in the Welcome screen
BRIDGE_IMAGE ?= ghcr.io/$(GHCR_USER)/otel-ui-bridge:$(BRIDGE_TAG)

# ── Colours ───────────────────────────────────────────────────────────────────
BOLD  := \033[1m
GREEN := \033[32m
CYAN  := \033[36m
GREY  := \033[90m
RESET := \033[0m

# ══════════════════════════════════════════════════════════════════════════════
# Help
# ══════════════════════════════════════════════════════════════════════════════

.PHONY: help
help: ## Show this help message
	@echo ""
	@echo "  $(BOLD)OTel UI$(RESET)"
	@echo ""
	@echo "  $(BOLD)Usage:$(RESET)"
	@awk 'BEGIN {FS = ":.*##"} /^[a-zA-Z_-]+:.*##/ { printf "    $(GREEN)%-20s$(RESET) %s\n", $$1, $$2 }' $(MAKEFILE_LIST)
	@echo ""
	@echo ""
	@echo "  $(BOLD)Examples:$(RESET)"
	@echo "    $(GREY)make dev-all                    # run backend + frontend natively$(RESET)"
	@echo ""

# ══════════════════════════════════════════════════════════════════════════════
# Build
# ══════════════════════════════════════════════════════════════════════════════

.PHONY: build-backend
build-backend: ## Build only the Rust backend (native)
	cd backend && cargo build --release

.PHONY: build-frontend
build-frontend: ## Build only the frontend (native, output → frontend/dist/)
	cd frontend && npm install && BRIDGE_IMAGE=$(BRIDGE_IMAGE) node build.mjs

# ══════════════════════════════════════════════════════════════════════════════
# Dev mode  (no Docker — run everything natively with hot-reload)
# ══════════════════════════════════════════════════════════════════════════════

.PHONY: dev-backend
dev-backend: ## Run Rust backend natively (OTLP :4317, WebSocket :8080)
	@echo ""
	@echo "  $(BOLD)Starting backend$(RESET)  (OTLP :4317, WS :$(BACKEND_PORT))"
	@echo ""
	cd backend && \
		RUST_LOG=otel_ui_backend=info \
		cargo run

.PHONY: dev-frontend
dev-frontend: ## Run frontend dev server with live-reload (http://localhost:$(FRONTEND_DEV_PORT))
	@echo ""
	@echo "  $(BOLD)Starting frontend dev server$(RESET)  → http://localhost:$(FRONTEND_DEV_PORT)"
	@echo ""
	@cd frontend && npm install --silent && BRIDGE_IMAGE=$(BRIDGE_IMAGE) FRONTEND_DEV_PORT=$(FRONTEND_DEV_PORT) node build.mjs --dev

.PHONY: dev-all
dev-all: ## Run backend + frontend natively — UI at http://localhost:$(FRONTEND_DEV_PORT)
	@$(MAKE) dev-backend &
	@sleep 1
	@$(MAKE) dev-frontend

# ══════════════════════════════════════════════════════════════════════════════
# Frontend utilities
# ══════════════════════════════════════════════════════════════════════════════

.PHONY: typecheck
typecheck: ## Run TypeScript type-check on the frontend
	cd frontend && npx tsc --noEmit

.PHONY: e2e
e2e: build-frontend ## Build frontend then run Playwright e2e tests
	cd frontend && npx playwright test

# ══════════════════════════════════════════════════════════════════════════════
# Docker — bridge image
# ══════════════════════════════════════════════════════════════════════════════

.PHONY: docker-build
docker-build: ## Build the bridge Docker image locally
	docker build -f Dockerfile.bridge -t ghcr.io/$(GHCR_USER)/otel-ui-bridge:$(BRIDGE_TAG) .

.PHONY: docker-run
docker-run: ## Run the bridge image locally  (-p 4317 OTLP gRPC, -p 8080 WS)
	docker run --rm -p 4317:4317 -p 8080:8080 ghcr.io/$(GHCR_USER)/otel-ui-bridge:$(BRIDGE_TAG)

.PHONY: docker-push
docker-push: docker-build ## Build and push the bridge image to ghcr.io  (requires: docker login ghcr.io)
	docker push ghcr.io/$(GHCR_USER)/otel-ui-bridge:$(BRIDGE_TAG)

# ══════════════════════════════════════════════════════════════════════════════
# Cleanup
# ══════════════════════════════════════════════════════════════════════════════

.PHONY: clean
clean: ## Remove frontend build artefacts
	rm -rf frontend/dist frontend/node_modules

.PHONY: clean-all
clean-all: clean ## Remove all build artefacts (frontend + Rust target)
	cd backend && cargo clean

.DEFAULT_GOAL := help
