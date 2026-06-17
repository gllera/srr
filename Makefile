.PHONY: verify verify-fe verify-be lint-fe format-check-fe format-fe test-fe build-fe dev-fe vet-be build-be test-be test-contract test-browser test-stress test-e2e generate generate-check release clean

SHELL := /bin/bash -e

PLATFORMS := linux/amd64 linux/arm64 darwin/amd64 darwin/arm64 windows/amd64 windows/arm64

# verify includes the fast jsdom e2e contract layer; the heavier headless-browser
# layer (test-browser) is opt-in via test-e2e.
verify: verify-fe verify-be test-contract
verify-fe: lint-fe format-check-fe test-fe build-fe
verify-be: vet-be build-be test-be generate-check

# frontend/src/js/format.gen.ts is generated from the backend's Go
# data-contract declarations (srr gen-ts). generate rewrites it;
# generate-check (in verify-be) fails when it is stale.
generate:
	cd backend && go generate .

generate-check:
	cd backend && go run . gen-ts --check

# End-to-end (writer<->reader contract). Both layers run the real srrb binary
# ($SRR_BIN, built by build-be) and read its packs with the real frontend code.
test-contract test-browser: build-be frontend/node_modules/.package-lock.json
	cd frontend && SRR_BIN=../dist/srrb npm run $@

test-e2e: test-contract test-browser

# Stress/performance layer (opt-in, NOT in verify). Generates or reuses a large
# (>50k-article) synthetic store via the gated Go generator (genbig_test.go) and
# measures navigation/filtering/query cost at scale. Tunable:
#   SRR_STRESS_N=<articles>      store size to generate (default 60000)
#   SRR_STRESS_STORE=<dir>       use an existing store instead of generating
test-stress: build-be frontend/node_modules/.package-lock.json
	cd frontend && SRR_BIN=../dist/srrb npm run test-stress

frontend/node_modules/.package-lock.json: frontend/package-lock.json
	cd frontend && npm ci

lint-fe format-check-fe format-fe test-fe build-fe dev-fe: frontend/node_modules/.package-lock.json
	cd frontend && npm run $(@:-fe=)

vet-be test-be:
	cd backend && go $(@:-be=) ./...

dist:
	@mkdir -p $@

build-be: | dist
	cd backend && go build -o ../dist/srrb .

release: verify-be | dist
	@cd backend; for p in $(PLATFORMS); do \
	  os=$${p%/*}; arch=$${p#*/}; ext=; \
	  [ $$os = windows ] && ext=.exe; \
	  CGO_ENABLED=0 GOOS=$$os GOARCH=$$arch go build -trimpath \
	    -ldflags "-s -w -X main.version=$(VERSION)" -o ../dist/srr-$$os-$$arch$$ext .; \
	done

clean:
	rm -rf frontend/.parcel-cache dist
