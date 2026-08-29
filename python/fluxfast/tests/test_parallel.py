"""Tests for concurrent AnyIO resource resolution and error determinism."""

import time

import anyio
import pytest

from fluxfast import MemoryResourceCache, Page, resource
from fluxfast.engine import ResourceEngine
from fluxfast.errors import ResourceError
from fluxfast.timing import TimingMetrics


@pytest.mark.anyio
async def test_concurrent_resource_resolution():
    async def load_a():
        await anyio.sleep(0.05)
        return {"data": "A"}

    async def load_b():
        await anyio.sleep(0.08)
        return {"data": "B"}

    async def load_c():
        await anyio.sleep(0.10)
        return {"data": "C"}

    page = Page(
        component="test/parallel",
        resources=[
            resource("res_a", load_a),
            resource("res_b", load_b),
            resource("res_c", load_c),
        ],
    )

    cache = MemoryResourceCache()
    metrics = TimingMetrics()

    t0 = time.perf_counter()
    resolution = await ResourceEngine.resolve_page_resources(
        page=page,
        known_versions={},
        only_keys=None,
        cache=cache,
        metrics=metrics,
    )
    elapsed = time.perf_counter() - t0

    assert "res_a" in resolution.resources
    assert "res_b" in resolution.resources
    assert "res_c" in resolution.resources
    assert resolution.resources["res_a"].value == {"data": "A"}
    assert resolution.resources["res_b"].value == {"data": "B"}
    assert resolution.resources["res_c"].value == {"data": "C"}

    # Sequential would take >= 230ms (0.23s)
    # Concurrent should complete in roughly 100ms - 170ms with CI timing allowance
    assert elapsed < 0.20, f"Expected concurrent resolution (< 0.20s), took {elapsed:.3f}s"


@pytest.mark.anyio
async def test_loader_error_propagates_deterministically():
    async def good_loader():
        await anyio.sleep(0.02)
        return {"ok": True}

    async def failing_loader():
        await anyio.sleep(0.02)
        raise ValueError("Database connection lost")

    page = Page(
        component="test/failure",
        resources=[
            resource("res_ok", good_loader),
            resource("res_fail", failing_loader),
        ],
    )

    cache = MemoryResourceCache()
    metrics = TimingMetrics()

    with pytest.raises(ResourceError, match="Database connection lost"):
        await ResourceEngine.resolve_page_resources(
            page=page,
            known_versions={},
            only_keys=None,
            cache=cache,
            metrics=metrics,
        )


@pytest.mark.anyio
async def test_synchronous_loaders_do_not_block_each_other():
    def blocking(value: str):
        time.sleep(0.06)
        return value

    page = Page(
        component="test/sync-parallel",
        resources=[
            resource("a", lambda: blocking("a")),
            resource("b", lambda: blocking("b")),
            resource("c", lambda: blocking("c")),
        ],
    )

    started = time.perf_counter()
    resolution = await ResourceEngine.resolve_page_resources(
        page=page,
        known_versions={},
        only_keys=None,
        cache=MemoryResourceCache(),
        metrics=TimingMetrics(),
    )

    assert set(resolution.resources) == {"a", "b", "c"}
    assert time.perf_counter() - started < 0.14


@pytest.mark.anyio
async def test_deferred_declaration_remains_blocking_without_client_capability():
    calls = 0

    async def load_analytics():
        nonlocal calls
        calls += 1
        return {"visits": 42}

    page = Page(
        component="dashboard/index",
        resources=[resource("analytics", load_analytics, defer=True)],
    )

    resolution = await ResourceEngine.resolve_page_resources(
        page=page,
        known_versions={},
        only_keys=None,
        cache=MemoryResourceCache(),
        metrics=TimingMetrics(),
    )

    assert calls == 1
    assert resolution.resources["analytics"].value == {"visits": 42}
