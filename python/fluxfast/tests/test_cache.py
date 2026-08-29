"""Tests for MemoryResourceCache (TTL, LRU eviction, and tag invalidation)."""

import time

import anyio
import pytest

from fluxfast.cache import CachedResource, MemoryResourceCache


@pytest.mark.anyio
async def test_cache_get_and_set():
    cache = MemoryResourceCache(max_entries=10)
    res = CachedResource(
        version="v1",
        value={"data": 123},
        expires_at=time.monotonic() + 10.0,
    )
    await cache.set("user:1::profile", res, ttl=10.0)

    got = await cache.get("user:1::profile")
    assert got is not None
    assert got.version == "v1"
    assert got.value == {"data": 123}


@pytest.mark.anyio
async def test_cache_ttl_expiration():
    cache = MemoryResourceCache(max_entries=10)
    # Resource expires in 0.05 seconds
    res = CachedResource(
        version="v1",
        value="quick",
        expires_at=time.monotonic() + 0.05,
    )
    await cache.set("key1", res, ttl=0.05)

    got = await cache.get("key1")
    assert got is not None

    await anyio.sleep(0.06)
    got_expired = await cache.get("key1")
    assert got_expired is None


@pytest.mark.anyio
async def test_cache_lru_eviction():
    cache = MemoryResourceCache(max_entries=3)
    now = time.monotonic()

    await cache.set("k1", CachedResource("v1", 1, now + 100), 100)
    await cache.set("k2", CachedResource("v2", 2, now + 100), 100)
    await cache.set("k3", CachedResource("v3", 3, now + 100), 100)

    # Access k1 to make it most recently used
    await cache.get("k1")

    # Add k4 -> should evict k2 (least recently used)
    await cache.set("k4", CachedResource("v4", 4, now + 100), 100)

    assert await cache.get("k1") is not None
    assert await cache.get("k2") is None  # Evicted
    assert await cache.get("k3") is not None
    assert await cache.get("k4") is not None


@pytest.mark.anyio
async def test_cache_tag_invalidation():
    cache = MemoryResourceCache(max_entries=10)
    now = time.monotonic()

    await cache.set(
        "tenant:1::rooms",
        CachedResource("v1", ["101", "102"], now + 100, tags=("hotel:1", "rooms")),
        100,
    )
    await cache.set(
        "tenant:1::stats",
        CachedResource("v2", {"occupied": 2}, now + 100, tags=("hotel:1", "stats")),
        100,
    )
    await cache.set(
        "tenant:2::rooms",
        CachedResource("v3", ["201"], now + 100, tags=("hotel:2", "rooms")),
        100,
    )

    # Invalidate tag "hotel:1"
    await cache.invalidate_tag("hotel:1")

    assert await cache.get("tenant:1::rooms") is None
    assert await cache.get("tenant:1::stats") is None
    # Tenant 2 data should remain intact
    assert await cache.get("tenant:2::rooms") is not None


def test_cache_rejects_non_positive_capacity():
    with pytest.raises(ValueError, match="greater than zero"):
        MemoryResourceCache(max_entries=0)


@pytest.mark.anyio
async def test_cache_set_uses_backend_ttl_argument():
    cache = MemoryResourceCache(max_entries=10)
    await cache.set(
        "short",
        CachedResource("v1", "value", time.monotonic() + 60),
        ttl=0.01,
    )
    await anyio.sleep(0.02)
    assert await cache.get("short") is None
