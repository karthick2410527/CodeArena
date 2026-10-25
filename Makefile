#  make help   lists every target
#
# Two ways to run VoidRun:
#   make up           everything in Docker
#   make infra + make api + make worker + make web   services in Docker, the rest on the host
#
SHELL := /bin/bash
MVN := cd backend && ./mvnw -B -ntp

.PHONY: help up down logs ps prod-up prod-down prod-logs make-admin infra api worker web runner-image recorder-image test test-api test-web lint check loadtest clean reset

help:  ## list targets
	@grep -hE '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
	  | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

# ---------------------------------------------------------------- everything

up: runner-image recorder-image  ## build and start the whole stack in Docker
	docker compose up -d --build --wait
	@echo "web  http://localhost:5173"
	@echo "api  http://localhost:8080/actuator/health"

down:          ## stop the stack (keeps data)
	docker compose down

logs:          ## follow API and worker logs
	docker compose logs -f api worker

runner-image:  ## build the sandbox image runs and submissions are judged in
	docker build -f backend/docker/runner.Dockerfile -t voidrun-runner:latest backend/docker

recorder-image:  ## build the sandbox image that Debug replays are recorded in
	docker build -f backend/docker/recorder.Dockerfile -t voidrun-recorder:latest backend/docker

ps:            ## show service status
	docker compose ps

# --------------------------------------------------------------- production

PROD := docker compose -f docker-compose.yml -f docker-compose.prod.yml

prod-up: runner-image recorder-image  ## production: build and start behind Caddy (HTTPS); needs .env (docs/DEPLOY.md)
	$(PROD) up -d --build --wait
	@echo "live at https://$$(grep -E '^DOMAIN=' .env | cut -d= -f2)"

prod-down:     ## production: stop (keeps data)
	$(PROD) down

prod-logs:     ## production: follow API, worker and Caddy logs
	$(PROD) logs -f api worker caddy

make-admin:    ## give NAME=<username> the admin role (they sign in again to get it)
	@test -n "$(NAME)" || (echo "usage: make make-admin NAME=<username>" && exit 1)
	echo "UPDATE users SET role = 'ADMIN' WHERE username = :'name';" \
	  | docker compose exec -T postgres psql -U voidrun -d voidrun -v name='$(NAME)'

# --------------------------------------------------- host development

infra:         ## start only PostgreSQL, Redis and Kafka
	docker compose up -d --wait postgres redis kafka

api:           ## run the API on the host (needs JWT_SECRET; applies migrations on start)
	$(MVN) -q -pl voidrun-api -am package -DskipTests
	cd backend && java -jar voidrun-api/target/voidrun-api-0.1.0-SNAPSHOT.jar

worker:        ## run the judge and replay worker on the host (needs Docker and both sandbox images)
	$(MVN) -q -pl voidrun-worker -am package -DskipTests
	cd backend && java -jar voidrun-worker/target/voidrun-worker-0.1.0-SNAPSHOT.jar

web:           ## run the Vite dev server
	cd frontend && npm run dev

# --------------------------------------------------------------------- checks

test: test-api test-web  ## run every automated test

test-api:      ## backend unit + integration tests (needs Docker for Testcontainers)
	$(MVN) verify

test-web:      ## frontend tests
	cd frontend && npm test

lint:          ## TypeScript type check
	cd frontend && npm run typecheck

check: lint test  ## type check, test everything, production build
	cd frontend && npm run build

loadtest:      ## modest repeatable load test (see docs/history/LOADTEST.md)
	./backend/scripts/loadtest.sh

# ---------------------------------------------------------------------- reset

clean:         ## remove build output
	$(MVN) -q clean
	rm -rf frontend/dist frontend/node_modules/.vite

reset:         ## DESTROY local data and start over
	docker compose down -v
	docker compose up -d --wait postgres redis kafka
