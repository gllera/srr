.PHONY: install verify verify-fe verify-be lint-fe format-check-fe format-fe test-fe build-fe dev-fe vet-be build-be release-be release test-be clean

PLATFORMS := linux/amd64 linux/arm64 darwin/amd64 darwin/arm64 windows/amd64 windows/arm64

install:
	cd frontend && npm ci

verify: verify-fe verify-be
verify-fe: lint-fe format-check-fe test-fe build-fe
verify-be: vet-be build-be test-be

lint-fe format-check-fe format-fe test-fe build-fe dev-fe:
	cd frontend && npm run $(@:-fe=)

vet-be test-be:
	cd backend && go $(@:-be=) ./...

build-be:
	mkdir -p dist && cd backend && go build -o ../dist/srrb .

release-be:
	cd backend && CGO_ENABLED=0 GOOS=$(GOOS) GOARCH=$(GOARCH) go build -trimpath \
	  -ldflags "-s -w -X main.version=$(VERSION)" -o $(OUT) .

release: install verify
	@set -e; for t in $(PLATFORMS); do \
	  os=$${t%/*}; arch=$${t#*/}; ext=""; \
	  if [ "$$os" = windows ]; then ext=.exe; fi; \
	  $(MAKE) release-be GOOS=$$os GOARCH=$$arch OUT=srr-$$os-$$arch$$ext VERSION=$(VERSION); \
	done
	tar -czf srrf-$(VERSION).tar.gz -C dist srrf

clean:
	rm -rf frontend/.parcel-cache backend/backend backend/debug dist srrf-*.tar.gz backend/srr-*
