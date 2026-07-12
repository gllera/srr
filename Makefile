.PHONY: verify verify-fe verify-be lint-fe format-check-fe format-fe test-fe build-fe smoke-fe dev-fe vet-be lint-be format-check-be format-be build-be test-be test-contract test-browser test-stress test-e2e generate generate-check release clean design-fixture design design-shots

SHELL := /bin/bash -e

PLATFORMS := linux/amd64 linux/arm64 darwin/amd64 darwin/arm64 windows/amd64 windows/arm64

# verify includes the fast jsdom e2e contract layer; the heavier headless-browser
# layer (test-browser) is opt-in via test-e2e.
verify: verify-fe verify-be test-contract
# smoke-fe runs the built bundle through a fast, Chrome-free boot check — it
# fails if Parcel dropped a build-time define, the regression that shipped a
# bundle which threw on boot while every other gate stayed green.
verify-fe: lint-fe format-check-fe test-fe build-fe smoke-fe
# verify-be mirrors verify-fe's gates: vet + gofmt check + lint + build +
# test + contract freshness.
verify-be: vet-be format-check-be lint-be build-be test-be generate-check

# frontend/src/js/format.gen.ts is generated from the backend's Go
# data-contract declarations (srr gen-ts). generate rewrites it;
# generate-check (in verify-be) fails when it is stale.
generate:
	cd backend && go generate .

generate-check:
	cd backend && go run . gen-ts --check

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

lint-fe format-check-fe format-fe test-fe build-fe smoke-fe dev-fe: frontend/node_modules/.package-lock.json
	cd frontend && npm run $(@:-fe=)

# The boot smoke reads the build output, so it must run after build-fe (the
# order-only prereq holds even under parallel make).
smoke-fe: build-fe

vet-be test-be:
	cd backend && go $(@:-be=) ./...

# Go format gate + linter, mirroring lint-fe/format-fe/format-check-fe. Both
# gate verify-be (format-check-be + lint-be; config in backend/.golangci.yml).
format-be:
	cd backend && gofmt -w .

format-check-be:
	@cd backend && out=$$(gofmt -l .); if [ -n "$$out" ]; then \
	  echo "gofmt needed (run 'make format-be'):"; echo "$$out"; exit 1; fi

lint-be:
	cd backend && golangci-lint run ./...

dist:
	@mkdir -p $@

build-be: | dist
	cd backend && go build -o ../dist/srr .

release: verify-be | dist
	@[ -n "$(VERSION)" ] || { echo 'VERSION= is required for release (e.g. make release VERSION=v1.2.3)' >&2; exit 1; }
	@cd backend; for p in $(PLATFORMS); do \
	  os=$${p%/*}; arch=$${p#*/}; ext=; \
	  [ $$os = windows ] && ext=.exe; \
	  CGO_ENABLED=0 GOOS=$$os GOARCH=$$arch go build -trimpath \
	    -ldflags "-s -w -X main.version=$(VERSION)" -o ../dist/srr-$$os-$$arch$$ext .; \
	done

clean:
	rm -rf frontend/.parcel-cache dist
