.PHONY: setup dev image test test-unit test-ui

PYTHON ?= .venv/bin/python
PIP ?= .venv/bin/pip

setup:
	python3 -m venv .venv
	$(PIP) install -r requirements-dev.txt
	npm install
	npx playwright install chromium

dev:
	POTATO_ENABLE_ORCHESTRATOR=0 $(PYTHON) -m uvicorn core.main:app --host 0.0.0.0 --port 1983

image:
	./bin/build_local_image.sh --setup-docker

test:
	$(PYTHON) -m pytest tests/unit tests/api -q -n auto && npx playwright test --reporter=dot --timeout=15000 --workers=75%

test-unit:
	$(PYTHON) -m pytest tests/unit tests/api -q -n auto

test-ui:
	npx playwright test --reporter=dot --timeout=15000 --workers=75%
