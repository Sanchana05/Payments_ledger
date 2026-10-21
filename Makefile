SHELL := /bin/bash
COMPOSE ?= docker compose
export DATABASE_URL ?= postgres://ledger:ledger@localhost:54329/ledger
export SEED_ROWS ?= 10000000

.PHONY: all up down install migrate test seed bench report psql typecheck clean help

help:
	@echo "make all        - up -> install -> migrate -> test -> seed -> bench -> report"
	@echo "make up         - start PostgreSQL (waits until healthy)"
	@echo "make migrate    - apply db/migrations/*.sql"
	@echo "make test       - invariant, concurrency and crash-recovery suites"
	@echo "make seed       - generate SEED_ROWS skewed ledger rows (default 10M)"
	@echo "make bench      - run the benchmark suite and index/partition experiments"
	@echo "make report     - render the one-page summary from bench/reports"
	@echo "make clean      - stop PostgreSQL and delete its volume"

# Tests run BEFORE seeding: they create throwaway databases on the same server, and
# the crash test restarts the container, which would otherwise evict the seeded
# data from shared_buffers.
all: up install migrate test seed bench report

up:
	$(COMPOSE) up -d --wait db

down:
	$(COMPOSE) down

install:
	npm install

typecheck: install
	npm run typecheck

migrate: install
	npm run migrate

test: install
	npm test

seed: install
	npm run seed

bench: install
	npm run bench

report: install
	npm run report

psql:
	$(COMPOSE) exec db psql -U ledger -d ledger

clean:
	$(COMPOSE) down -v
	rm -rf dist
