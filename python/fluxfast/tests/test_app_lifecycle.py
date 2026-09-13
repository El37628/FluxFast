"""Tests for FluxFast-owned shutdown integration."""

from __future__ import annotations

from contextlib import asynccontextmanager

import anyio
import pytest
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient

from fluxfast import FluxFast, MemoryLiveBroker, MemoryResourceCache


class RecordingCache(MemoryResourceCache):
    def __init__(self, events: list[str]) -> None:
        super().__init__()
        self.events = events
        self.close_count = 0

    async def close(self) -> None:
        self.close_count += 1
        self.events.append("cache")


class RecordingBroker(MemoryLiveBroker):
    def __init__(self, events: list[str]) -> None:
        super().__init__()
        self.events = events
        self.close_count = 0

    async def close(self) -> None:
        self.close_count += 1
        self.events.append("broker")
        await super().close()


def test_fastapi_shutdown_closes_broker_then_closeable_cache() -> None:
    events: list[str] = []
    cache = RecordingCache(events)
    broker = RecordingBroker(events)
    app = FastAPI()
    flux = FluxFast(app, cache=cache, broker=broker)

    with TestClient(app):
        assert events == []

    assert events == ["broker", "cache"]
    assert broker.close_count == 1
    assert cache.close_count == 1
    assert app.state.fluxfast_cache is cache
    assert app.state.fluxfast_live is flux.live


def test_fastapi_shutdown_keeps_custom_cache_without_close_compatible() -> None:
    cache = MemoryResourceCache()
    app = FastAPI()
    FluxFast(app, cache=cache)

    with TestClient(app):
        pass


def test_fluxfast_close_is_idempotent_and_supports_sync_cache_close() -> None:
    events: list[str] = []

    class SyncCloseCache(MemoryResourceCache):
        def close(self) -> None:
            events.append("cache")

    broker = RecordingBroker(events)
    flux = FluxFast(FastAPI(), cache=SyncCloseCache(), broker=broker)

    anyio.run(flux.close)
    anyio.run(flux.close)

    assert events == ["broker", "cache"]
    assert broker.close_count == 1


@pytest.mark.anyio
async def test_cache_still_closes_when_broker_shutdown_fails() -> None:
    events: list[str] = []

    class FailingBroker(RecordingBroker):
        async def close(self) -> None:
            self.close_count += 1
            self.events.append("broker")
            raise RuntimeError("broker close failed")

    cache = RecordingCache(events)
    broker = FailingBroker(events)
    flux = FluxFast(FastAPI(), cache=cache, broker=broker)

    with pytest.raises(RuntimeError, match="broker close failed"):
        await flux.close()

    assert events == ["broker", "cache"]
    assert cache.close_count == 1


@pytest.mark.anyio
async def test_concurrent_close_calls_share_one_shutdown_sequence() -> None:
    events: list[str] = []
    cache = RecordingCache(events)
    broker = RecordingBroker(events)
    flux = FluxFast(FastAPI(), cache=cache, broker=broker)

    async with anyio.create_task_group() as tasks:
        for _index in range(50):
            tasks.start_soon(flux.close)

    assert events == ["broker", "cache"]
    assert broker.close_count == 1
    assert cache.close_count == 1
    assert flux.health.shutting_down is True


def test_custom_application_lifespan_preserves_state_and_owned_cleanup() -> None:
    events: list[str] = []

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        events.append("application startup")
        try:
            yield {"application_state": "preserved"}
        finally:
            assert flux.health.shutting_down is True
            events.append("application shutdown")

    app = FastAPI(lifespan=lifespan)
    flux = FluxFast(app, cache=RecordingCache(events), broker=RecordingBroker(events))

    @app.get("/state")
    async def state(request: Request):
        return {"value": request.state.application_state}

    with TestClient(app) as client:
        assert client.get("/_fluxfast/readyz").status_code == 200
        assert client.get("/state").json() == {"value": "preserved"}
        assert events == ["application startup"]

    assert events == ["application startup", "application shutdown", "broker", "cache"]
    assert flux.health.shutting_down is True


@pytest.mark.anyio
async def test_concurrent_close_waits_until_owned_cleanup_finishes() -> None:
    entered = anyio.Event()
    release = anyio.Event()
    second_returned = anyio.Event()
    events: list[str] = []

    class SlowBroker(RecordingBroker):
        async def close(self) -> None:
            entered.set()
            await release.wait()
            await super().close()

    flux = FluxFast(FastAPI(), cache=RecordingCache(events), broker=SlowBroker(events))

    async def second_close() -> None:
        await flux.close()
        second_returned.set()

    async with anyio.create_task_group() as tasks:
        tasks.start_soon(flux.close)
        await entered.wait()
        tasks.start_soon(second_close)
        for _ in range(5):
            await anyio.lowlevel.checkpoint()
        completed_early = second_returned.is_set()
        release.set()

    assert not completed_early
    assert second_returned.is_set()
    assert events == ["broker", "cache"]


@pytest.mark.anyio
async def test_cancelled_shutdown_still_closes_broker_and_cache_once() -> None:
    events: list[str] = []

    class YieldingBroker(RecordingBroker):
        async def close(self) -> None:
            await anyio.lowlevel.checkpoint()
            await super().close()

    class YieldingCache(RecordingCache):
        async def close(self) -> None:
            await anyio.lowlevel.checkpoint()
            await super().close()

    broker = YieldingBroker(events)
    cache = YieldingCache(events)
    flux = FluxFast(FastAPI(), cache=cache, broker=broker)

    with anyio.CancelScope() as cancellation:
        cancellation.cancel()
        await flux.close()
    await flux.close()

    assert events == ["broker", "cache"]
    assert broker.close_count == cache.close_count == 1


@pytest.mark.parametrize("phase", ["startup", "shutdown"])
def test_failing_custom_lifespan_still_releases_owned_dependencies(phase: str) -> None:
    events: list[str] = []

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        if phase == "startup":
            raise RuntimeError("application startup failed")
        yield
        raise RuntimeError("application shutdown failed")

    app = FastAPI(lifespan=lifespan)
    flux = FluxFast(app, cache=RecordingCache(events), broker=RecordingBroker(events))
    with pytest.raises(RuntimeError, match=f"application {phase} failed"), TestClient(app):
        pass
    assert events == ["broker", "cache"]
    assert flux.health.shutting_down is True
    assert anyio.run(flux.health.ready) is False


def test_100_independent_application_startup_shutdown_cycles() -> None:
    for _ in range(100):
        events: list[str] = []
        app = FastAPI()
        flux = FluxFast(app, cache=RecordingCache(events), broker=RecordingBroker(events))
        with TestClient(app) as client:
            assert client.get("/_fluxfast/readyz").status_code == 200
        anyio.run(flux.close)
        assert events == ["broker", "cache"]
        assert flux.live.broker.subscriber_count == 0
        assert flux.health.shutting_down is True


@pytest.mark.anyio
@pytest.mark.parametrize("anyio_backend", ["asyncio"])
async def test_reentrant_dependency_close_does_not_deadlock(anyio_backend) -> None:
    import asyncio

    events: list[str] = []

    class ReentrantCache(RecordingCache):
        async def close(self) -> None:
            await flux.close()
            await super().close()

    flux = FluxFast(FastAPI(), cache=ReentrantCache(events), broker=RecordingBroker(events))
    await asyncio.wait_for(flux.close(), timeout=2)
    assert events == ["broker", "cache"]
