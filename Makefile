.PHONY: dev image test test-unit test-ui

dev:
	POTATO_ENABLE_ORCHESTRATOR=0 uv run uvicorn core.main:app --host 0.0.0.0 --port 1983

image:
	./bin/build_local_image.sh --setup-docker

test:
	uv run python -m pytest tests/unit tests/api -q -n auto && npx playwright test --reporter=dot --timeout=15000 --workers=75%

test-unit:
	uv run python -m pytest tests/unit tests/api -q -n auto

test-ui:
	npx playwright test --reporter=dot --timeout=15000 --workers=75%
