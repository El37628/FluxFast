"""Tests for capability-aware initial deferred resource resolution."""

import pytest

from fluxfast import MemoryResourceCache, Page, resource, scope
from fluxfast.engine import ResourceEngine
from fluxfast.timing import TimingMetrics


@pytest.mark.anyio
async def test_supported_client_defers_cache_misses_but_resolves_blocking_resources():
    calls = {"summary": 0, "analytics": 0}

    async def load_summary():
        calls["summary"] += 1
        return {"total": 4}

    async def load_analytics():
        calls["analytics"] += 1
        return {"visits": 42}

    resolution = await ResourceEngine.resolve_page_resources(
        page=Page(
            "dashboard/index",
            [
                resource("summary", load_summary),
                resource("analytics", load_analytics, defer=True),
            ],
        ),
        known_versions={},
        only_keys=None,
        cache=MemoryResourceCache(),
        metrics=TimingMetrics(),
        client_supports_deferred=True,
    )

    assert calls == {"summary": 1, "analytics": 0}
    assert resolution.resources["summary"].value == {"total": 4}
    assert resolution.deferred == ["analytics"]


@pytest.mark.anyio
async def test_deferred_cache_hit_is_immediate_and_known_hit_is_not_pending():
    calls = 0

    async def load_analytics():
        nonlocal calls
        calls += 1
        return {"visits": 42}

    page = Page(
        "dashboard/index",
        [
            resource(
                "analytics",
                load_analytics,
                scope=scope.public(),
                ttl=60,
                defer=True,
            )
        ],
    )
    cache = MemoryResourceCache()
    initial = await ResourceEngine.resolve_page_resources(
        page, {}, None, cache, TimingMetrics()
    )
    version = initial.resources["analytics"].version

    cached = await ResourceEngine.resolve_page_resources(
        page,
        {},
        None,
        cache,
        TimingMetrics(),
        client_supports_deferred=True,
    )
    known = await ResourceEngine.resolve_page_resources(
        page,
        {"analytics": version},
        None,
        cache,
        TimingMetrics(),
        client_supports_deferred=True,
    )

    assert calls == 1
    assert cached.resources["analytics"].version == version
    assert cached.deferred == []
    assert known.resources == {}
    assert known.deferred == []


@pytest.mark.anyio
async def test_explicit_only_request_executes_a_deferred_loader():
    calls = 0

    async def load_analytics():
        nonlocal calls
        calls += 1
        return {"visits": 42}

    resolution = await ResourceEngine.resolve_page_resources(
        page=Page(
            "dashboard/index",
            [resource("analytics", load_analytics, defer=True)],
        ),
        known_versions={},
        only_keys={"analytics"},
        cache=MemoryResourceCache(),
        metrics=TimingMetrics(),
        client_supports_deferred=True,
    )

    assert calls == 1
    assert resolution.resources["analytics"].value == {"visits": 42}
    assert resolution.deferred == []
