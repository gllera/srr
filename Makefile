.PHONY: verify verify-fe verify-be check-admin-placeholder check-coverage-test fuzz-be lint-fe format-check-fe format-fe test-fe build-fe build-admin smoke-fe dev-fe vet-be lint-be format-check-be format-be build-be test-be test-race-be test-contract test-browser test-stress test-e2e generate generate-check release clean design-fixture design design-shots build-cloud verify-cloud smoke-cloud deploy-cloud

SHELL := /bin/bash -e

PLATFORMS := linux/amd64 linux/arm64 darwin/amd64 darwin/arm64 windows/amd64 windows/arm64

# release stamps main.version. CI passes VERSION= (the tag); locally it defaults
# to a git description so an ad-hoc build is still traceable to a commit.
VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo development)

# verify includes the fast jsdom e2e contract layer; the heavier headless-browser
# layer (test-browser) is opt-in via test-e2e.
#
#
# verify-cloud is deliberately NOT here, and that is not the same as ungated:
# ci.yml runs it as its own step beside this one. release.yml gates every
# release artifact on `make verify`, so folding the worker in would have made a
# wrangler/workerd/vitest-pool-workers breakage block shipping the srr BINARY —
# coupling the backend's release to a Cloudflare toolchain it does not use.
# Keep this target the frontend+backend contract release.yml means by it.
verify: verify-fe verify-be test-contract
# smoke-fe runs the built bundle through a fast, Chrome-free boot check — it
# fails if Parcel dropped a build-time define, the regression that shipped a
# bundle which threw on boot while every other gate stayed green.
verify-fe: lint-fe format-check-fe test-fe build-fe smoke-fe
# verify-be mirrors verify-fe's gates: vet + gofmt check + lint + build +
# test + contract freshness.
verify-be: vet-be format-check-be lint-be build-be test-be generate-check check-admin-placeholder check-coverage-test

# frontend/src/js/format.gen.ts is generated from the backend's Go
# data-contract declarations (srr gen-ts). generate rewrites it;
# generate-check (in verify-be) fails when it is stale. SRR_CONFIG_INLINE={}
# pins an empty config: the generator must not depend on — or fail on — the
# host's ~/.config/srr/srr.yaml (e.g. a pre-scope secrets: section).
generate:
	cd backend && SRR_CONFIG_INLINE='{}' go generate .

generate-check:
	cd backend && SRR_CONFIG_INLINE='{}' go run . gen-ts --check

# End-to-end (writer<->reader contract). All layers run the real srr binary
# ($SRR_BIN, built by build-be) and read its packs with the real frontend code.
# test-stress is the opt-in stress/performance layer (NOT in verify): it
# generates or reuses a large (>50k-article) synthetic store via the gated Go
# generator (genbig_test.go) and measures navigation/filtering/query cost at
# scale. Tunable:
#   SRR_STRESS_N=<articles>      store size to generate (default 60000)
#   SRR_STRESS_STORE=<dir>       use an existing store instead of generating
test-contract test-browser test-stress: build-be frontend/node_modules/.package-lock.json
	cd frontend && SRR_BIN=../dist/srr npm run $@

test-e2e: test-contract test-browser

# Build the curated design-harness fixture store (real srr), then run the dev
# servers against it so /design.html shows every curated state. design-fixture
# needs the srr binary (build-be) and gates the generator on SRR_DESIGN_GEN.
design-fixture: build-be frontend/node_modules/.package-lock.json
	cd frontend && SRR_BIN=../dist/srr SRR_DESIGN_GEN=1 npm run gen-design

design: frontend/node_modules/.package-lock.json
	cd frontend && SRR_STORE=e2e/fixtures/design-store npm run dev

# Capture every design-harness state to PNGs (light + dark) for headless / CI
# grounding. Needs the puppeteer Chromium (same as test-browser). Reuses the
# fixture store if it's already present; builds it only when missing (run
# `make design-fixture` to force a rebuild).
design-shots: frontend/node_modules/.package-lock.json
	@test -f frontend/e2e/fixtures/design-store/db.gz || $(MAKE) design-fixture
	cd frontend && npm run shoot-design

frontend/node_modules/.package-lock.json: frontend/package-lock.json
	cd frontend && npm ci

lint-fe format-check-fe format-fe test-fe smoke-fe dev-fe: frontend/node_modules/.package-lock.json
	cd frontend && npm run $(@:-fe=)

# The npm `build` script wipes ../dist/srrf before running Parcel — Parcel never
# cleans, so every content-hash change used to leave its predecessor behind and
# the dir grew without bound (129 frontend.*.js at the 2026-07-20 audit). That
# matters because the whole dir SHIPS: release.yml tars it into srrf.tar.gz and
# Direct-Uploads it to Cloudflare Pages, so the pile was deployed too. The wipe
# lives in package.json (next to build-admin's identical rm -f, and so it also
# covers a bare `npm run build`) and is scoped to dist/srrf, NEVER dist/ — the
# release job runs `make release` BEFORE `make build-fe`, so wiping dist/ would
# delete the cross-compiled dist/srr-* binaries it is about to attach.
#
# build-fe also copies frontend/_headers into the bundle (Parcel has no
# public-dir copy) — the reader CSP header layer for the cf-pages deploy;
# rides srrf.tar.gz too, where it is inert at a store root. It runs AFTER the
# build, so the wipe can't take it with it.
build-fe: frontend/node_modules/.package-lock.json
	cd frontend && npm run build
	cp frontend/_headers dist/srrf/_headers

# The boot smoke reads the build output, so it must run after build-fe (the
# order-only prereq holds even under parallel make).
smoke-fe: build-fe

# --- SRR Cloud (cloud/worker) ---------------------------------------------
# build-cloud stages the store-root reader bundle (dist/srrf, relative
# PACK_BASE — the `srr frontend update` shell) as the Worker's static assets.
# _headers is a Pages artifact; the Worker sets its own headers, so it is
# dropped rather than served as a file.
cloud/worker/node_modules/.package-lock.json: cloud/worker/package-lock.json
	cd cloud/worker && npm ci

# wrangler.toml is gitignored (one operator's hostname, zone and login URL), so
# a fresh clone and CI get a placeholder copy of the committed example. NO
# prerequisite on purpose: make runs this only when the file does not exist, so
# editing the example can never clobber a real config.
cloud/worker/wrangler.toml:
	cp cloud/worker/wrangler.example.toml $@
	@echo "note: created $@ from the example — edit it before deploying"

build-cloud: build-fe
	rm -rf cloud/worker/public
	mkdir -p cloud/worker/public
	cp -r dist/srrf/. cloud/worker/public/
	rm -f cloud/worker/public/_headers

verify-cloud: build-cloud cloud/worker/wrangler.toml cloud/worker/node_modules/.package-lock.json
	cd cloud/worker && npm run check && npm run test

# Opt-in end-to-end smoke: real srr store → local R2 → wrangler dev → HTTP
# checks per route class. Needs the srr binary and the staged bundle.
smoke-cloud: build-cloud build-be cloud/worker/wrangler.toml cloud/worker/node_modules/.package-lock.json
	node cloud/e2e/smoke.mjs

# DEPLOY IS MANUAL AND CURRENTLY DEFERRED — see the phase-1 plan's runbook.
# The guard is not paranoia: verify-cloud materializes a placeholder config when
# none exists, so without it a first-time deploy would happily publish a Worker
# routed at example.com.
# Comment lines are stripped first, deliberately: the example EXPLAINS this guard
# and so mentions example.com itself, which would otherwise block a config whose
# values are perfectly real.
deploy-cloud: verify-cloud
	@grep -v '^[[:space:]]*#' cloud/worker/wrangler.toml | grep -q "example\.com" \
	   && { echo "refusing to deploy: cloud/worker/wrangler.toml still holds example.com placeholders"; exit 1; } || true
	cd cloud/worker && npx wrangler deploy

vet-be test-be:
	cd backend && go $(@:-be=) ./...

# The concurrency gate, kept OUT of verify (it is ~2-5x slower): the fetch loop,
# asset pool and serve handlers are all concurrent, while the suite swaps
# package-level globals wholesale — so -race catches the data races and -shuffle
# catches tests that only pass in declaration order. CI runs it as its own job.
test-race-be:
	cd backend && go test -race -shuffle=on ./...

# The fuzz gate, also kept OUT of verify: a SMOKE pass over every target (the
# store's two byte-level parsers, the feed parser and the sanitizer), long enough
# to catch a target that no longer compiles or that the checked-in seed corpus
# already breaks, short enough to run on demand. Real fuzzing is the nightly CI
# job, which runs the same targets with a much larger FUZZTIME and reports any
# crasher it writes to testdata/. Override the budget per target with
# `make fuzz-be FUZZTIME=5m`.
FUZZTIME ?= 20s
FUZZ_TARGETS = .:FuzzParseIdxPack .:FuzzIdxWriteParse .:FuzzParseSeen ./ingest:FuzzParseFeed ./mod:FuzzSanitize

fuzz-be:
	@cd backend && for t in $(FUZZ_TARGETS); do \
	  pkg=$${t%%:*}; fn=$${t##*:}; \
	  echo "==> $$fn ($$pkg, $(FUZZTIME))"; \
	  go test $$pkg -run '^$$' -fuzz "^$$fn$$" -fuzztime=$(FUZZTIME) || exit 1; \
	done

# The chaos gate, kept OUT of verify for the same reason as fuzz-be and
# test-race-be: it is a SEARCH, not a check. Every curated e2e fixture in this
# repo is a store shape somebody thought of, and the bugs that shipped lived in
# the combinatorics between them (the pack<->delta seam x expiration x feed
# churn x GC window x compaction). This walks that space from a seed, drives the
# real production write path, and asserts inspect --validate, chron permanence
# against an independent oracle, every live chron's payload, and consolidation
# equivalence against the --max-deltas=0 kill switch. A seeded walk finds
# nothing on most runs and cannot gate a PR on wall-clock it may spend for no
# signal, so `verify` never runs it (SRR_CHAOS gates the driver itself) and
# .github/workflows/chaos.yml runs it nightly with a real budget.
#
# Every seed is PRINTED, so a nightly red replays locally with one command:
#   make chaos-be CHAOS_SEED=<the seed the failure printed>
# Tunables: CHAOS_SEEDS (how many random seeds), CHAOS_SEED (replay exactly
# one), CHAOS_ARTICLES (article budget per seed), CHAOS_OUT (keep each seed's
# store there instead of a temp dir — the CI artifact, and the fixture the
# jsdom pass frontend/e2e/contract/chaos.e2e.test.ts reads), CHAOS_TIMEOUT.
CHAOS_SEEDS ?= 4
CHAOS_ARTICLES ?= 600
CHAOS_TIMEOUT ?= 3600s

.PHONY: chaos-be
chaos-be:
	cd backend && SRR_CHAOS=1 \
	  SRR_CHAOS_SEEDS=$(CHAOS_SEEDS) SRR_CHAOS_ARTICLES=$(CHAOS_ARTICLES) \
	  SRR_CHAOS_SEED=$(CHAOS_SEED) SRR_CHAOS_OUT=$(CHAOS_OUT) \
	  go test -run '^TestChaosStore$$' -count=1 -timeout $(CHAOS_TIMEOUT) -v .

# Go format gate + linter, mirroring lint-fe/format-fe/format-check-fe. Both
# gate verify-be (format-check-be + lint-be; config in backend/.golangci.yml).
format-be:
	cd backend && gofmt -w .

format-check-be:
	@cd backend && out=$$(gofmt -l .); if [ -n "$$out" ]; then \
	  echo "gofmt needed (run 'make format-be'):"; echo "$$out"; exit 1; fi

lint-be:
	cd backend && golangci-lint run ./...

.PHONY: bench-be cover-be

# The measurement targets, both kept OUT of verify.
#
# bench-be: the store hot paths (backend/bench_test.go, TST5) — gzipBest per
# series, the delta-chain consolidation fold, the meta bloom build, the search
# fold. Not in verify because a benchmark has no pass/fail: it produces numbers
# a human (or benchstat) compares against another run, and the zopfli rows alone
# cost seconds per iteration. It is what GRO5 has to be decided on — read
# gzipBest's bytes-out/%-saved metrics against its ns/op, not the ns/op alone.
# Tunables: `make bench-be BENCHTIME=10x` (or 5s) for a tighter measurement,
# `make bench-be BENCH=GzipBest/data` to run one subset. The default 1s is Go's
# own, which self-adapts: the microbenchmarks get thousands of iterations while
# the multi-second zopfli rows get one.
BENCHTIME ?= 1s
BENCH ?= .

bench-be:
	cd backend && go test ./... -run '^$$' -bench '$(BENCH)' -benchtime=$(BENCHTIME) -benchmem

# cover-be: the coverage RATCHET (TST8). `go test` with a profile, then
# scripts/check-coverage.sh asserts every area in scripts/coverage-floors.tsv is
# at or above its committed floor and prints the actual-vs-floor delta. Not in
# verify because it re-runs the whole backend suite instrumented (roughly double
# test-be's wall time) to gate a P3 ratchet — the point is that the number
# cannot silently rot, not that every commit pays for it. Ratcheting a floor up
# is a one-line diff in the .tsv.
COVER_PROFILE ?= dist/coverage-be.out
COVER_FLOORS ?= scripts/coverage-floors.tsv

cover-be: | dist
	cd backend && go test -coverprofile=../$(COVER_PROFILE) -covermode=set ./...
	scripts/check-coverage.sh $(COVER_PROFILE) $(COVER_FLOORS)

# check-coverage-test: the ratchet's own test. It runs in verify (not just
# beside cover-be) because it is pure bash+awk and takes milliseconds, and
# because the thing it protects is a GATE: check-coverage.sh's four
# anti-vacuity guards — no-match area FAILS, empty profile EXITS 2, blocks
# deduped by span, malformed floors row EXITS 2 — all lived in one awk program
# that nothing exercised, so deleting any of them left `make cover-be`
# reporting green over nothing. (The fourth was added after the first three:
# they were all on the PROFILE side, while the FLOORS parser could retire an
# area's gate just as silently by skipping a row it could not split.)
check-coverage-test:
	scripts/check-coverage.test.sh

# check-admin-placeholder: backend/webui/dist/index.html is the ONE committed
# file in an otherwise-generated directory — the placeholder that lets a
# Node-less `go build`/`go vet`/`go test` compile the //go:embed. build-admin
# overwrites it in the worktree on every build, so committing it by reflex
# (`git add -A`) replaces it with a Parcel bundle whose admin.<hash>.{js,css}
# are gitignored: a fresh clone then embeds a page with two dangling asset
# references — an unstyled shell with dead tabs — instead of the "run
# make build-admin" note. That shipped once; this is the gate.
#
# It inspects the COMMITTED blob, never the worktree, precisely because verify
# itself regenerates the worktree copy a step earlier (build-be -> build-admin).
check-admin-placeholder:
	@if ! git show HEAD:backend/webui/dist/index.html 2>/dev/null | grep -q 'SRR admin console — placeholder'; then \
	  echo "backend/webui/dist/index.html is committed as a BUILT bundle, not the placeholder."; \
	  echo "Its hashed assets are gitignored, so a Node-less build embeds dangling refs."; \
	  echo "Fix: git checkout origin/main -- backend/webui/dist/index.html && git commit"; \
	  exit 1; \
	fi

dist:
	@mkdir -p $@

# build-admin is its OWN parcel build into backend/webui/dist — a SEPARATE dist
# from the reader (../dist/srrf), NOT a shared multi-entry build: a shared build
# could hoist common chunks and rewrite the reader's content-hashed filenames,
# which must stay byte-identical. `srr serve` embeds this dir via //go:embed.
build-admin: frontend/node_modules/.package-lock.json
	cd frontend && npm run build-admin

# build-be depends on build-admin so the embedded admin console is fresh before
# `go build` reads it (mirrors CI, which builds the frontend anyway). A bare
# `go build`/`go test` without this target still compiles against the committed
# placeholder backend/webui/dist/index.html.
build-be: build-admin | dist
	cd backend && go build -o ../dist/srr .

release: verify-be | dist
	@echo "release version: $(VERSION)"
	@cd backend; for p in $(PLATFORMS); do \
	  os=$${p%/*}; arch=$${p#*/}; ext=; \
	  [ $$os = windows ] && ext=.exe; \
	  CGO_ENABLED=0 GOOS=$$os GOARCH=$$arch go build -trimpath \
	    -ldflags "-s -w -X main.version=$(VERSION)" -o ../dist/srr-$$os-$$arch$$ext .; \
	done

clean:
	rm -rf frontend/.parcel-cache dist
	rm -f backend/webui/dist/*.js backend/webui/dist/*.css
