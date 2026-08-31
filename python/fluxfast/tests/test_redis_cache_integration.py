"""Real Redis integration coverage for distributed resource caching."""

from __future__ import annotations

import os
import time
from collections.abc import Awaitable, Callable
from typing import Any
from uuid import uuid4

import anyio
import pytest

from fluxfast import CachedResource, RedisResourceCache
from fluxfast._redis_cache_keys import RedisCacheKeyspace

REDIS_URL = os.getenv("FLUXFAST_TEST_REDIS_URL")
pytestmark = pytest.mark.skipif(
    REDIS_URL is None,
    reason="set FLUXFAST_TEST_REDIS_URL to run real Redis integration tests",
)


def _resource(
    version: str,
    value: object,
    *,
    tags: tuple[str, ...] = (),
) -> CachedResource:
    return CachedResource(
        version=version,
        value=value,
        expires_at=time.monotonic() + 60,
        tags=tags,
    )


async def _race(
    *operations: Callable[[], Awaitable[Any]],
) -> list[Any]:
    start = anyio.Event()
    ready = [anyio.Event() for _operation in operations]
    results: list[Any] = [None] * len(operations)

    async def run(
        index: int,
        operation: Callable[[], Awaitable[Any]],
    ) -> None:
        ready[index].set()
        await start.wait()
        results[index] = await operation()

    async with anyio.create_task_group() as tasks:
        for index, operation in enumerate(operations):
            tasks.start_soon(run, index, operation)
        for event in ready:
            await event.wait()
        start.set()

    return results


async def _assert_single_resource_is_consistent(
    admin: Any,
    keyspace: RedisCacheKeyspace,
    logical_key: str,
    resource: CachedResource | None,
) -> None:
    keys = {
        key
        async for key in admin.scan_iter(
            match=keyspace.scan_pattern,
            count=100,
        )
    }
    if resource is None:
        assert keys == set()
        return

    resource_key = keyspace.resource_key(logical_key)
    membership_key = keyspace.resource_tags_key(logical_key)
    tag_keys = {keyspace.tag_key(tag) for tag in resource.tags}
    expected = {resource_key.encode(), *(key.encode() for key in tag_keys)}
    if tag_keys:
        expected.add(membership_key.encode())
    assert keys == expected
    assert await admin.smembers(membership_key) == {
        key.encode() for key in tag_keys
    }
    for tag_key in tag_keys:
        assert await admin.zrange(tag_key, 0, -1) == [resource_key.encode()]


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


@pytest.mark.anyio
async def test_tag_invalidation_crosses_clients_and_stays_in_namespace() -> None:
    assert REDIS_URL is not None
    from redis.asyncio import Redis

    unique = uuid4().hex
    namespace = f"test-invalidate-{unique}"
    keyspace = RedisCacheKeyspace(namespace)
    writer = RedisResourceCache.from_url(REDIS_URL, namespace=namespace)
    invalidator = RedisResourceCache.from_url(REDIS_URL, namespace=namespace)
    admin = Redis.from_url(REDIS_URL)
    external_key = f"outside-fluxfast-{unique}"
    shared_tag_key = keyspace.tag_key("shared")

    try:
        first = _resource("first-v1", "first")
        first.tags = ("shared", "first-only")
        second = _resource("second-v1", "second")
        second.tags = ("shared", "second-only")
        keep = _resource("keep-v1", "keep")
        keep.tags = ("keep",)
        await writer.set("first", first, ttl=60)
        await writer.set("second", second, ttl=60)
        await writer.set("keep", keep, ttl=60)

        await admin.set(external_key, b"preserve", px=60_000)
        await admin.zadd(
            shared_tag_key,
            {external_key: time.time() * 1000 + 60_000},
        )

        await invalidator.invalidate_tag("shared")

        assert await writer.get("first") is None
        assert await writer.get("second") is None
        kept = await writer.get("keep")
        assert kept is not None and kept.value == "keep"
        assert await admin.get(external_key) == b"preserve"
        assert await admin.exists(
            shared_tag_key,
            keyspace.tag_key("first-only"),
            keyspace.tag_key("second-only"),
            keyspace.resource_tags_key("first"),
            keyspace.resource_tags_key("second"),
        ) == 0

        await invalidator.invalidate_tag("shared")
    finally:
        await writer.delete("first")
        await writer.delete("second")
        await writer.delete("keep")
        await admin.delete(external_key)
        await admin.aclose()
        await invalidator.close()
        await writer.close()


@pytest.mark.anyio
async def test_clear_unlinks_only_the_exact_encoded_namespace() -> None:
    assert REDIS_URL is not None
    from redis.asyncio import Redis

    unique = uuid4().hex
    parent_namespace = f"clear-{unique}"
    child_namespace = f"{parent_namespace}:blue"
    parent_keyspace = RedisCacheKeyspace(parent_namespace)
    parent = RedisResourceCache.from_url(
        REDIS_URL,
        namespace=parent_namespace,
        scan_count=1,
    )
    child = RedisResourceCache.from_url(REDIS_URL, namespace=child_namespace)
    admin = Redis.from_url(REDIS_URL)
    external_key = f"outside-clear-{unique}"

    try:
        parent_resource = _resource("parent-v1", "parent")
        parent_resource.tags = ("shared",)
        child_resource = _resource("child-v1", "child")
        child_resource.tags = ("shared",)
        await parent.set("rooms", parent_resource, ttl=60)
        await child.set("rooms", child_resource, ttl=60)
        await admin.set(external_key, b"preserve", px=60_000)

        await parent.clear()

        assert await parent.get("rooms") is None
        child_hit = await child.get("rooms")
        assert child_hit is not None and child_hit.value == "child"
        assert await admin.get(external_key) == b"preserve"
        remaining = [
            key
            async for key in admin.scan_iter(
                match=parent_keyspace.scan_pattern,
                count=100,
            )
        ]
        assert remaining == []
    finally:
        await parent.clear()
        await child.clear()
        await admin.delete(external_key)
        await admin.aclose()
        await child.close()
        await parent.close()


@pytest.mark.anyio
async def test_corrupt_entry_self_recovers_without_leaving_tag_indexes() -> None:
    assert REDIS_URL is not None
    from redis.asyncio import Redis

    namespace = f"test-corrupt-{uuid4().hex}"
    keyspace = RedisCacheKeyspace(namespace)
    cache = RedisResourceCache.from_url(REDIS_URL, namespace=namespace)
    admin = Redis.from_url(REDIS_URL)
    resource_key = keyspace.resource_key("rooms")
    membership_key = keyspace.resource_tags_key("rooms")
    tag_key = keyspace.tag_key("rooms")

    try:
        future_ms = time.time() * 1000 + 60_000
        await admin.set(resource_key, b"not-valid-json", px=60_000)
        await admin.sadd(membership_key, tag_key)
        await admin.pexpire(membership_key, 60_000)
        await admin.zadd(tag_key, {resource_key: future_ms})
        await admin.pexpire(tag_key, 60_000)

        assert await cache.get("rooms") is None
        assert await admin.exists(resource_key, membership_key, tag_key) == 0
    finally:
        await cache.clear()
        await admin.aclose()
        await cache.close()


@pytest.mark.anyio
async def test_namespace_tag_and_clear_operations_are_fully_isolated() -> None:
    assert REDIS_URL is not None
    from redis.asyncio import Redis

    deployment = uuid4().hex
    first_namespace = f"test-isolation-a-{deployment}"
    second_namespace = f"test-isolation-b-{deployment}"
    first = RedisResourceCache.from_url(
        REDIS_URL,
        namespace=first_namespace,
    )
    second = RedisResourceCache.from_url(
        REDIS_URL,
        namespace=second_namespace,
    )
    admin = Redis.from_url(REDIS_URL)
    logical_key = "tenant:1::rooms"

    try:
        await first.set(
            logical_key,
            _resource("a-v1", {"application": "a"}, tags=("shared",)),
            ttl=60,
        )
        await second.set(
            logical_key,
            _resource("b-v1", {"application": "b"}, tags=("shared",)),
            ttl=60,
        )

        await first.invalidate_tag("shared")

        assert await first.get(logical_key) is None
        second_hit = await second.get(logical_key)
        assert second_hit is not None
        assert second_hit.value == {"application": "b"}
        await _assert_single_resource_is_consistent(
            admin,
            RedisCacheKeyspace(first_namespace),
            logical_key,
            None,
        )
        await _assert_single_resource_is_consistent(
            admin,
            RedisCacheKeyspace(second_namespace),
            logical_key,
            second_hit,
        )

        await first.set(
            logical_key,
            _resource("a-v2", {"application": "a2"}, tags=("shared",)),
            ttl=60,
        )
        await first.clear()

        assert await first.get(logical_key) is None
        second_hit = await second.get(logical_key)
        assert second_hit is not None
        assert second_hit.value == {"application": "b"}
        await _assert_single_resource_is_consistent(
            admin,
            RedisCacheKeyspace(first_namespace),
            logical_key,
            None,
        )
        await _assert_single_resource_is_consistent(
            admin,
            RedisCacheKeyspace(second_namespace),
            logical_key,
            second_hit,
        )
    finally:
        await first.clear()
        await second.clear()
        await admin.aclose()
        await second.close()
        await first.close()


@pytest.mark.anyio
@pytest.mark.parametrize("_iteration", range(8))
async def test_concurrent_operations_never_leave_malformed_cache_state(
    _iteration: int,
) -> None:
    assert REDIS_URL is not None
    from redis.asyncio import Redis

    namespace = f"test-concurrency-{uuid4().hex}"
    keyspace = RedisCacheKeyspace(namespace)
    first = RedisResourceCache.from_url(REDIS_URL, namespace=namespace)
    second = RedisResourceCache.from_url(REDIS_URL, namespace=namespace)
    admin = Redis.from_url(REDIS_URL)
    logical_key = "tenant:1::rooms"

    async def delayed_expiry_read() -> CachedResource | None:
        await anyio.sleep(0.08)
        return await second.get(logical_key)

    try:
        # get + delete: the read can be a valid hit or miss, while delete wins
        # the final state and removes every tag index.
        await first.set(
            logical_key,
            _resource("base-v1", "base", tags=("base",)),
            ttl=60,
        )
        read_result, _deleted = await _race(
            lambda: first.get(logical_key),
            lambda: second.delete(logical_key),
        )
        assert read_result is None or read_result.value == "base"
        assert await first.get(logical_key) is None
        await _assert_single_resource_is_consistent(admin, keyspace, logical_key, None)

        # set + delete: either operation may win, but the surviving entry and
        # all indexes must describe one complete write.
        replacement = _resource(
            "replacement-v1",
            "replacement",
            tags=("replacement",),
        )
        await _race(
            lambda: first.set(logical_key, replacement, ttl=60),
            lambda: second.delete(logical_key),
        )
        final = await first.get(logical_key)
        assert final is None or final.value == "replacement"
        await _assert_single_resource_is_consistent(admin, keyspace, logical_key, final)

        # set + tag invalidation: last-command-wins is allowed; partial tag
        # membership or malformed data is not.
        await first.clear()
        await first.set(
            logical_key,
            _resource("base-v2", "base", tags=("shared",)),
            ttl=60,
        )
        shared_replacement = _resource(
            "replacement-v2",
            "replacement",
            tags=("shared", "replacement"),
        )
        await _race(
            lambda: first.set(logical_key, shared_replacement, ttl=60),
            lambda: second.invalidate_tag("shared"),
        )
        final = await first.get(logical_key)
        assert final is None or final.value == "replacement"
        await _assert_single_resource_is_consistent(admin, keyspace, logical_key, final)

        # Two simultaneous sets are atomic and last-writer-wins as a complete
        # value plus its exact tag membership.
        await first.clear()
        first_write = _resource("first-v1", "first", tags=("first",))
        second_write = _resource("second-v1", "second", tags=("second",))
        await _race(
            lambda: first.set(logical_key, first_write, ttl=60),
            lambda: second.set(logical_key, second_write, ttl=60),
        )
        final = await first.get(logical_key)
        assert final is not None
        assert (final.version, final.value, final.tags) in {
            ("first-v1", "first", ("first",)),
            ("second-v1", "second", ("second",)),
        }
        await _assert_single_resource_is_consistent(admin, keyspace, logical_key, final)

        # clear + read can return the valid pre-clear value or a miss; once
        # clear completes, no namespace-local data remains.
        read_result, _cleared = await _race(
            lambda: first.get(logical_key),
            second.clear,
        )
        assert read_result is None or read_result.value in {"first", "second"}
        assert await first.get(logical_key) is None
        await _assert_single_resource_is_consistent(admin, keyspace, logical_key, None)

        # TTL expiration + reads may straddle the deadline, but every hit is a
        # complete value and the post-deadline state is a clean miss.
        await first.set(
            logical_key,
            _resource("expiring-v1", "expiring", tags=("expiring",)),
            ttl=0.04,
        )
        immediate, expired = await _race(
            lambda: first.get(logical_key),
            delayed_expiry_read,
        )
        assert immediate is None or immediate.value == "expiring"
        assert expired is None
        assert await first.get(logical_key) is None
        await _assert_single_resource_is_consistent(admin, keyspace, logical_key, None)
    finally:
        await first.clear()
        await admin.aclose()
        await second.close()
        await first.close()
