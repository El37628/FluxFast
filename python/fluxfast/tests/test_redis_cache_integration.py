"""Real Redis integration coverage for distributed resource caching."""

from __future__ import annotations

import os
import time
from uuid import uuid4

import pytest

from fluxfast import CachedResource, RedisResourceCache

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
