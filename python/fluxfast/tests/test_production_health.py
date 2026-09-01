"""Tests for minimal production liveness and readiness endpoints."""

from __future__ import annotations

import anyio
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from fluxfast import FluxFast, MemoryResourceCache
from fluxfast.production import (
    HEALTH_PATH,
    READINESS_PATH,
    ProductionHealthState,
)


def test_fluxfast_health_routes_report_minimal_lifecycle_state() -> None:
    app = FastAPI()
    flux = FluxFast(app)

    assert anyio.run(flux.health.ready) is False
    with TestClient(app) as client:
        liveness = client.get(HEALTH_PATH)
        assert liveness.status_code == 200
        assert liveness.json() == {"status": "ok"}
        assert liveness.headers["cache-control"] == "no-store"
        readiness = client.get(READINESS_PATH)
        assert readiness.status_code == 200
        assert readiness.json() == {"status": "ready"}
        assert readiness.headers["cache-control"] == "no-store"
        openapi_paths = client.get("/openapi.json").json()["paths"]
        assert HEALTH_PATH not in openapi_paths
        assert READINESS_PATH not in openapi_paths

    assert flux.health.shutting_down is True
    assert anyio.run(flux.health.ready) is False
    assert app.state.fluxfast_health is flux.health


def test_readiness_contains_dependency_failure_without_leaking_details() -> None:
    class UnavailableCache(MemoryResourceCache):
        async def healthcheck(self) -> bool:
            raise ConnectionError("redis://user:secret@example.invalid/0")

    app = FastAPI()
    FluxFast(app, cache=UnavailableCache())

    with TestClient(app) as client:
        response = client.get(READINESS_PATH)

    assert response.status_code == 503
    assert response.json() == {"status": "not_ready"}
    assert response.headers["cache-control"] == "no-store"
    assert "secret" not in response.text
    assert "redis" not in response.text


@pytest.mark.anyio
async def test_readiness_times_out_slow_owned_dependencies() -> None:
    class SlowDependency:
        async def healthcheck(self) -> bool:
            await anyio.sleep(10)
            return True

    state = ProductionHealthState((SlowDependency(),), dependency_timeout=0.01)
    await state.startup()

    assert await state.ready() is False


@pytest.mark.anyio
async def test_readiness_accepts_sync_healthcheck_and_rejects_shutdown() -> None:
    class ReadyDependency:
        def healthcheck(self) -> bool:
            return True

    state = ProductionHealthState((ReadyDependency(),))
    await state.startup()
    assert await state.ready() is True

    await state.shutdown()
    assert await state.ready() is False


@pytest.mark.parametrize("path", [HEALTH_PATH, READINESS_PATH])
def test_fluxfast_rejects_preexisting_reserved_health_routes(path: str) -> None:
    app = FastAPI()

    @app.get(path)
    async def conflicting_route() -> dict[str, str]:
        return {"configuration": "sensitive"}

    with pytest.raises(ValueError, match="reserved for FluxFast"):
        FluxFast(app)
