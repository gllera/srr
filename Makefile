.PHONY: install verify verify-fe verify-be lint-fe format-check-fe format-fe test-fe build-fe dev-fe vet-be build-be test-be clean

install:
	cd frontend && npm ci

verify: verify-fe verify-be
verify-fe: lint-fe format-check-fe test-fe build-fe
verify-be: vet-be build-be test-be

lint-fe format-check-fe format-fe test-fe build-fe dev-fe:
	cd frontend && npm run $(@:-fe=)

vet-be build-be test-be:
	cd backend && go $(@:-be=) ./...

clean:
	rm -rf frontend/dist frontend/.parcel-cache backend/backend backend/debug
