"""Tests for FluxFast-owned shutdown integration."""

from __future__ import annotations

import anyio
import pytest
from fastapi import FastAPI
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
