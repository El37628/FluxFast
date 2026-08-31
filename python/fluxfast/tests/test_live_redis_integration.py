"""Real Redis integration coverage for cross-worker Live Resources."""

from __future__ import annotations

import os
import shutil
import time
from collections.abc import AsyncIterator
from uuid import uuid4

import anyio
import anyio.lowlevel
import pytest
from fastapi import FastAPI

from fluxfast import (
    FluxFast,
    LiveEvent,
    LiveInvalidateEvent,
    Page,
    RedisLiveBroker,
    RedisResourceCache,
    derive_live_topic,
    resource,
    scope,
)
from fluxfast.engine import ResourceEngine
from fluxfast.timing import TimingMetrics

REDIS_URL = os.getenv("FLUXFAST_TEST_REDIS_URL")
REDIS_CONTAINER = os.getenv("FLUXFAST_TEST_REDIS_CONTAINER")
pytestmark = pytest.mark.skipif(
    REDIS_URL is None,
    reason="set FLUXFAST_TEST_REDIS_URL to run real Redis integration tests",
)


async def _receive_one(
    stream: AsyncIterator[LiveEvent],
    received: list[LiveEvent],
) -> None:
    received.append(await anext(stream))


async def _wait_for_subscribers(broker: RedisLiveBroker, count: int) -> None:
    with anyio.fail_after(5):
        while broker.subscriber_count != count:
            await anyio.lowlevel.checkpoint()


@pytest.mark.anyio
async def test_events_cross_worker_brokers_and_remain_tenant_isolated() -> None:
    assert REDIS_URL is not None
    publisher = RedisLiveBroker.from_url(REDIS_URL)
    subscriber = RedisLiveBroker.from_url(REDIS_URL)
    tenant_a_topic = derive_live_topic(scope.tenant("tenant-a"), "summary")
    tenant_b_topic = derive_live_topic(scope.tenant("tenant-b"), "summary")
    tenant_a_stream = subscriber.subscribe({tenant_a_topic})
    tenant_b_stream = subscriber.subscribe({tenant_b_topic})
    tenant_a_received: list[LiveEvent] = []
    tenant_b_received: list[LiveEvent] = []

    try:
        async with anyio.create_task_group() as tasks:
            tasks.start_soon(_receive_one, tenant_a_stream, tenant_a_received)
            tasks.start_soon(_receive_one, tenant_b_stream, tenant_b_received)
            await _wait_for_subscribers(subscriber, 2)
            await publisher.publish(
                tenant_a_topic,
                LiveInvalidateEvent(keys=["summary"], originClientId="ff_a"),
            )
            await publisher.publish(
                tenant_b_topic,
                LiveInvalidateEvent(keys=["summary"], originClientId="ff_b"),
            )

        assert tenant_a_received == [
            LiveInvalidateEvent(keys=["summary"], originClientId="ff_a")
        ]
        assert tenant_b_received == [
            LiveInvalidateEvent(keys=["summary"], originClientId="ff_b")
        ]
    finally:
        await tenant_a_stream.aclose()
        await tenant_b_stream.aclose()
        await subscriber.close()
        await publisher.close()


@pytest.mark.anyio
async def test_subscriber_cleanup_and_reconnect_receive_new_events() -> None:
    assert REDIS_URL is not None
    publisher = RedisLiveBroker.from_url(REDIS_URL)
    subscriber = RedisLiveBroker.from_url(REDIS_URL)
    topic = derive_live_topic(scope.public(), "status")

    async def receive_after_subscribe(stream: AsyncIterator[LiveEvent]) -> LiveEvent:
        received: list[LiveEvent] = []
        async with anyio.create_task_group() as tasks:
            tasks.start_soon(_receive_one, stream, received)
            await _wait_for_subscribers(subscriber, 1)
            await publisher.publish(topic, LiveInvalidateEvent(keys=["status"]))
        return received[0]

    try:
        first = subscriber.subscribe({topic})
        assert await receive_after_subscribe(first) == LiveInvalidateEvent(
            keys=["status"]
        )
        await first.aclose()
        await _wait_for_subscribers(subscriber, 0)

        reconnected = subscriber.subscribe({topic})
        assert await receive_after_subscribe(reconnected) == LiveInvalidateEvent(
            keys=["status"]
        )
        await reconnected.aclose()
        await _wait_for_subscribers(subscriber, 0)
    finally:
        await subscriber.close()
        await publisher.close()


@pytest.mark.anyio
async def test_positive_ttl_live_resource_invalidates_and_refills_shared_cache() -> None:
    assert REDIS_URL is not None
    deployment = uuid4().hex
    namespace = f"test-live-cache-{deployment}"
    channel_prefix = f"fluxfast:{namespace}:live:"
    worker_a_cache = RedisResourceCache.from_url(
        REDIS_URL,
        namespace=namespace,
    )
    worker_b_cache = RedisResourceCache.from_url(
        REDIS_URL,
        namespace=namespace,
    )
    worker_a = FluxFast(
        FastAPI(),
        cache=worker_a_cache,
        broker=RedisLiveBroker.from_url(
            REDIS_URL,
            channel_prefix=channel_prefix,
        ),
    )
    worker_b = FluxFast(
        FastAPI(),
        cache=worker_b_cache,
        broker=RedisLiveBroker.from_url(
            REDIS_URL,
            channel_prefix=channel_prefix,
        ),
    )
    resource_scope = scope.tenant("hotel-1")
    canonical = {"count": 1}
    loader_calls = 0

    async def load_summary() -> dict[str, int]:
        nonlocal loader_calls
        loader_calls += 1
        return dict(canonical)

    page = Page(
        "Dashboard",
        [
            resource(
                "summary",
                load_summary,
                scope=resource_scope,
                ttl=60,
                live=True,
            )
        ],
    )
    subscription = worker_b.live.resolve_subscription(page, {"summary"})
    stream = worker_b.live.subscribe(subscription)
    received: list[LiveEvent] = []

    try:
        first_metrics = TimingMetrics()
        first = await ResourceEngine.resolve_page_resources(
            page,
            {},
            None,
            worker_a_cache,
            first_metrics,
        )
        first_record = first.resources["summary"]
        assert first_record.value == {"count": 1}
        assert first_metrics.cache_misses == 1

        warm_metrics = TimingMetrics()
        warm = await ResourceEngine.resolve_page_resources(
            page,
            {},
            None,
            worker_b_cache,
            warm_metrics,
        )
        assert warm.resources["summary"] == first_record
        assert warm_metrics.cache_hits == 1
        assert loader_calls == 1

        canonical["count"] = 2
        async with anyio.create_task_group() as tasks:
            tasks.start_soon(_receive_one, stream, received)
            await _wait_for_subscribers(worker_b.live.broker, 1)
            await worker_a.live.invalidate(
                "summary",
                scope=resource_scope,
                origin_client_id="worker-a",
            )

        assert received == [
            LiveInvalidateEvent(
                keys=["summary"],
                originClientId="worker-a",
            )
        ]
        cache_key = ResourceEngine.get_cache_key(page.resources[0])
        assert await worker_b_cache.get(cache_key) is None

        refill_metrics = TimingMetrics()
        refill = await ResourceEngine.resolve_page_resources(
            page,
            {"summary": first_record.version},
            None,
            worker_b_cache,
            refill_metrics,
        )
        refill_record = refill.resources["summary"]
        assert refill_record.value == {"count": 2}
        assert refill_record.version != first_record.version
        assert refill_metrics.cache_misses == 1
        assert loader_calls == 2

        shared_refill = await worker_a_cache.get(cache_key)
        assert shared_refill is not None
        assert shared_refill.value == {"count": 2}
        assert shared_refill.version == refill_record.version
        assert shared_refill.expires_at > time.monotonic()
    finally:
        await stream.aclose()
        try:
            await worker_a_cache.clear()
        finally:
            try:
                await worker_b.close()
            finally:
                await worker_a.close()


@pytest.mark.anyio
async def test_pubsub_connection_loss_ends_stream_for_browser_resync() -> None:
    assert REDIS_URL is not None
    subscriber = RedisLiveBroker.from_url(REDIS_URL)
    admin = None
    stream = subscriber.subscribe({"opaque-restart-test"})

    async def wait_for_stream_end(ended: anyio.Event) -> None:
        async for _event in stream:
            pass
        ended.set()

    try:
        # Import only inside the enabled integration test, preserving optionality.
        from redis.asyncio import Redis

        admin = Redis.from_url(REDIS_URL)
        ended = anyio.Event()
        async with anyio.create_task_group() as tasks:
            tasks.start_soon(wait_for_stream_end, ended)
            await _wait_for_subscribers(subscriber, 1)
            await admin.execute_command("CLIENT", "KILL", "TYPE", "PUBSUB")
            with anyio.fail_after(5):
                await ended.wait()
    finally:
        await stream.aclose()
        await subscriber.close()
        if admin is not None:
            await admin.aclose()


@pytest.mark.skipif(
    REDIS_CONTAINER is None,
    reason="set FLUXFAST_TEST_REDIS_CONTAINER to test an actual broker restart",
)
@pytest.mark.anyio
async def test_actual_redis_restart_allows_a_fresh_subscription() -> None:
    assert REDIS_URL is not None
    assert REDIS_CONTAINER is not None
    docker = shutil.which("docker")
    if docker is None:
        pytest.skip("Docker is required to restart the Redis test service")

    subscriber = RedisLiveBroker.from_url(REDIS_URL)
    stream = subscriber.subscribe({"opaque-restart-test"})
    ended = anyio.Event()

    async def wait_for_stream_end() -> None:
        async for _event in stream:
            pass
        ended.set()

    try:
        async with anyio.create_task_group() as tasks:
            tasks.start_soon(wait_for_stream_end)
            await _wait_for_subscribers(subscriber, 1)
            await anyio.run_process(
                [docker, "restart", REDIS_CONTAINER],
                check=True,
            )
            with anyio.fail_after(10):
                await ended.wait()

        from redis.asyncio import Redis
        from redis.exceptions import ConnectionError as RedisConnectionError

        admin = Redis.from_url(REDIS_URL)
        try:
            with anyio.fail_after(10):
                while True:
                    try:
                        if await admin.ping():
                            break
                    except RedisConnectionError:
                        pass
                    await anyio.sleep(0.05)
        finally:
            await admin.aclose()

        publisher = RedisLiveBroker.from_url(REDIS_URL)
        reconnected = subscriber.subscribe({"opaque-restart-test"})
        received: list[LiveEvent] = []
        try:
            async with anyio.create_task_group() as tasks:
                tasks.start_soon(_receive_one, reconnected, received)
                await _wait_for_subscribers(subscriber, 1)
                await publisher.publish(
                    "opaque-restart-test",
                    LiveInvalidateEvent(keys=["status"]),
                )
            assert received == [LiveInvalidateEvent(keys=["status"])]
        finally:
            await reconnected.aclose()
            await publisher.close()
    finally:
        await stream.aclose()
        await subscriber.close()
