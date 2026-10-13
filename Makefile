#  make help   lists every target
#
# Two ways to run CodeArena:
#   make up           everything in Docker (Kafka queue, Docker-confined worker)
#   make dev-*        services in Docker, API/worker/web on the host
#
SHELL := /bin/bash
DB_URL ?= postgres://codearena:codearena@localhost:5432/codearena

.PHONY: help up down logs ps infra db api worker web \
        test test-api test-web fmt lint check loadtest clean reset dlq

help:  ## list targets
	@grep -hE '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
	  | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

# ---------------------------------------------------------------- everything

up:            ## build and start the whole stack in Docker
	docker compose up -d --build --wait
	@echo "web  http://localhost:5173"
	@echo "api  http://localhost:8080/api/v1/health"

down:          ## stop the stack (keeps data)
	docker compose down

logs:          ## follow API and worker logs
	docker compose logs -f api worker

ps:            ## show service status
	docker compose ps

# --------------------------------------------------- host development

infra:         ## start only PostgreSQL, Redis and Kafka
	docker compose up -d --wait postgres redis kafka

db:            ## start only PostgreSQL (enough for the test suite)
	docker compose up -d --wait postgres

api:           ## run the API on the host (applies migrations on start)
	cd backend && cargo run --bin codearena-api

worker:        ## run the judge worker on the host
	cd backend && cargo run --bin codearena-worker

web:           ## run the Vite dev server
	cd frontend && npm run dev

dlq:           ## list dead-lettered judge jobs
	cd backend && cargo run --quiet --bin codearena-dlq -- list

# --------------------------------------------------------------------- checks

test: test-api test-web  ## run every automated test

test-api:      ## backend unit + integration tests (needs `make db`)
	cd backend && DATABASE_URL=$(DB_URL) cargo test

test-web:      ## frontend tests
	cd frontend && npm test

fmt:           ## format Rust sources
	cd backend && cargo fmt

lint:          ## clippy + TypeScript type check
	cd backend && cargo clippy --all-targets -- -D warnings
	cd frontend && npm run typecheck

check: fmt lint test  ## format, lint and test everything
	cd frontend && npm run build

loadtest:      ## modest repeatable load test (see docs/LOADTEST.md)
	./scripts/loadtest.sh

# ---------------------------------------------------------------------- reset

clean:         ## remove build output
	cd backend && cargo clean
	rm -rf frontend/dist frontend/node_modules/.vite

reset:         ## DESTROY local data and start over
	docker compose down -v
	docker compose up -d --wait postgres redis kafka
