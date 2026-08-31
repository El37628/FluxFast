"""Real Redis integration coverage for distributed resource caching."""

from __future__ import annotations

import os
import time
from uuid import uuid4

import pytest

from fluxfast import CachedResource, RedisResourceCache
from fluxfast._redis_cache_keys import RedisCacheKeyspace

REDIS_URL = os.getenv("FLUXFAST_TEST_REDIS_URL")
pytestmark = pytest.mark.skipif(
    REDIS_URL is None,
    reason="set FLUXFAST_TEST_REDIS_URL to run real Redis integration tests",
)


def _resource(version: str, value: object) -> CachedResource:
    return CachedResource(
        version=version,
        value=value,
        expires_at=time.monotonic() + 60,
    )


@pytest.mark.anyio
async def test_delete_is_visible_across_independent_redis_clients() -> None:
    assert REDIS_URL is not None
    namespace = f"test-delete-{uuid4().hex}"
    writer = RedisResourceCache.from_url(REDIS_URL, namespace=namespace)
    reader = RedisResourceCache.from_url(REDIS_URL, namespace=namespace)

    try:
        await writer.set("rooms", _resource("rooms-v1", [101, 102]), ttl=60)
        await writer.set("stats", _resource("stats-v1", {"available": 2}), ttl=60)

        reader_hit = await reader.get("rooms")
        assert reader_hit is not None
        assert reader_hit.value == [101, 102]

        await reader.delete("rooms")

        assert await writer.get("rooms") is None
        remaining = await writer.get("stats")
        assert remaining is not None
        assert remaining.value == {"available": 2}
    finally:
        await writer.delete("rooms")
        await writer.delete("stats")
        await reader.close()
        await writer.close()


@pytest.mark.anyio
async def test_tag_indexes_track_overwrites_and_active_member_expiry() -> None:
    assert REDIS_URL is not None
    from redis.asyncio import Redis

    namespace = f"test-tags-{uuid4().hex}"
    keyspace = RedisCacheKeyspace(namespace)
    cache = RedisResourceCache.from_url(REDIS_URL, namespace=namespace)
    admin = Redis.from_url(REDIS_URL)
    shared_tag_key = keyspace.tag_key("shared")
    old_tag_key = keyspace.tag_key("old")
    new_tag_key = keyspace.tag_key("new")
    short_resource_key = keyspace.resource_key("short")
    long_resource_key = keyspace.resource_key("long")

    try:
        short = _resource("short-v1", "short")
        short.tags = ("shared", "old")
        long = _resource("long-v1", "long")
        long.tags = ("shared",)
        await cache.set("short", short, ttl=15)
        await cache.set("long", long, ttl=60)

        assert set(await admin.zrange(shared_tag_key, 0, -1)) == {
            short_resource_key.encode(),
            long_resource_key.encode(),
        }
        assert await admin.smembers(keyspace.resource_tags_key("short")) == {
            shared_tag_key.encode(),
            old_tag_key.encode(),
        }
        assert 50_000 <= await admin.pttl(shared_tag_key) <= 60_000

        replacement = _resource("long-v2", "replacement")
        replacement.tags = ("new",)
        await cache.set("long", replacement, ttl=30)

        assert await admin.zrange(shared_tag_key, 0, -1) == [
            short_resource_key.encode()
        ]
        assert 0 < await admin.pttl(shared_tag_key) <= 15_000
        assert await admin.zrange(new_tag_key, 0, -1) == [
            long_resource_key.encode()
        ]

        await cache.delete("short")

        assert await admin.exists(shared_tag_key, old_tag_key) == 0
        assert await admin.smembers(keyspace.resource_tags_key("short")) == set()
    finally:
        await cache.delete("short")
        await cache.delete("long")
        await admin.aclose()
        await cache.close()
