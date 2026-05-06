.PHONY: verify verify-fe verify-be lint-fe format-check-fe format-fe test-fe build-fe dev-fe vet-be build-be test-be release clean

SHELL := /bin/bash -e

PLATFORMS := linux/amd64 linux/arm64 darwin/amd64 darwin/arm64 windows/amd64 windows/arm64

verify: verify-fe verify-be
verify-fe: lint-fe format-check-fe test-fe build-fe
verify-be: vet-be build-be test-be

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
