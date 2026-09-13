"""Shutdown/cancellation ownership for cache and broker dependencies."""

from __future__ import annotations

import anyio
import pytest

from fluxfast import MemoryLiveBroker, RedisLiveBroker, RedisResourceCache


class PubSub:
    def __init__(self, *, delayed: bool = False, fail_close: bool = False) -> None:
        self.entered = anyio.Event()
        self.closed = anyio.Event()
        self.release = anyio.Event()
        self.fail_close = fail_close
        if not delayed:
            self.release.set()

    async def subscribe(self, *channels) -> None:
        self.entered.set()
        await self.release.wait()

    async def unsubscribe(self, *channels) -> None:
        await anyio.lowlevel.checkpoint()

    async def get_message(self, **kwargs):
        await self.closed.wait()
        raise ConnectionError("closed test subscription")

    async def aclose(self) -> None:
        await anyio.lowlevel.checkpoint()
        self.closed.set()
        self.release.set()
        if self.fail_close:
            raise RuntimeError("subscription close failed")


class RedisClient:
    def __init__(self, **pubsub_options) -> None:
        self.pubsub_options = pubsub_options
        self.subscriptions: list[PubSub] = []
        self.close_count = 0

    def pubsub(self, **kwargs) -> PubSub:
        subscription = PubSub(**self.pubsub_options)
        self.subscriptions.append(subscription)
        return subscription

    async def aclose(self) -> None:
        await anyio.lowlevel.checkpoint()
        self.close_count += 1

    async def ping(self) -> bool:
        return True


async def _consume(stream) -> None:
    async for _ in stream:
        pass


async def _wait_for(predicate) -> None:
    with anyio.fail_after(3):
        while not predicate():
            await anyio.lowlevel.checkpoint()


@pytest.mark.anyio
@pytest.mark.parametrize("dependency", [RedisLiveBroker, RedisResourceCache])
@pytest.mark.parametrize("owns_client", [False, True])
async def test_cancelled_close_preserves_redis_client_ownership(
    dependency, owns_client
) -> None:
    client = RedisClient()
    options = {"namespace": "lifecycle"} if dependency is RedisResourceCache else {}
    owner = dependency(client, owns_client=owns_client, **options)
    with anyio.CancelScope() as cancellation:
        cancellation.cancel()
        await owner.close()
    assert await owner.healthcheck() is False
    await owner.close()
    assert client.close_count == int(owns_client)
    assert await owner.healthcheck() is False


@pytest.mark.anyio
async def test_redis_subscriber_cancellation_releases_ownership_repeatedly() -> None:
    client = RedisClient()
    broker = RedisLiveBroker(client)
    try:
        for _ in range(100):
            stream = broker.subscribe({"lifecycle"})
            async with anyio.create_task_group() as tasks:
                tasks.start_soon(_consume, stream)
                await _wait_for(lambda: broker.subscriber_count == 1)
                tasks.cancel_scope.cancel()
            assert broker.subscriber_count == 0
            assert not broker._pending_subscriptions
            assert not broker._subscription_io
            assert client.subscriptions[-1].closed.is_set()
        assert client.close_count == 0
    finally:
        await broker.close()


@pytest.mark.anyio
async def test_close_owns_pubsub_while_subscribe_handshake_is_pending() -> None:
    client = RedisClient(delayed=True)
    broker = RedisLiveBroker(client, owns_client=True)
    stream = broker.subscribe({"lifecycle"})
    async with anyio.create_task_group() as tasks:
        tasks.start_soon(_consume, stream)
        await _wait_for(lambda: bool(client.subscriptions))
        subscription = client.subscriptions[0]
        await subscription.entered.wait()
        await broker.close()
        closed_before_handshake_release = subscription.closed.is_set()
        subscription.release.set()
    assert closed_before_handshake_release
    assert broker.subscriber_count == 0
    assert client.close_count == 1


@pytest.mark.anyio
@pytest.mark.parametrize("anyio_backend", ["asyncio"])
@pytest.mark.parametrize("dependency", [RedisLiveBroker, RedisResourceCache])
async def test_reentrant_redis_client_close_keeps_single_owner(
    anyio_backend, dependency
) -> None:
    import asyncio

    class ReentrantClient(RedisClient):
        async def aclose(self) -> None:
            await owner.close()
            await super().aclose()

    client = ReentrantClient()
    options = {"namespace": "reentrant"} if dependency is RedisResourceCache else {}
    owner = dependency(client, owns_client=True, **options)
    await asyncio.wait_for(owner.close(), timeout=2)
    assert client.close_count == 1


@pytest.mark.anyio
async def test_one_pubsub_close_failure_does_not_skip_other_owned_dependencies() -> (
    None
):
    client = RedisClient()
    broker = RedisLiveBroker(client, owns_client=True)
    # Isolate the shutdown owner's error path from separate consumer failures.
    subscriptions = [client.pubsub(), client.pubsub()]
    broker._subscriptions.update(subscriptions)
    subscriptions[0].fail_close = True
    with pytest.raises(RuntimeError, match="subscription close failed"):
        await broker.close()
    assert all(subscription.closed.is_set() for subscription in subscriptions)
    assert client.close_count == 1
    await broker.close()
    assert client.close_count == 1


@pytest.mark.anyio
async def test_cancelled_memory_broker_close_wakes_waiting_subscribers() -> None:
    broker = MemoryLiveBroker()
    finished = anyio.Event()

    async def consume() -> None:
        await _consume(broker.subscribe({"lifecycle"}))
        finished.set()

    async with anyio.create_task_group() as tasks:
        tasks.start_soon(consume)
        await _wait_for(lambda: broker.subscriber_count == 1)
        with anyio.CancelScope() as cancellation:
            cancellation.cancel()
            await broker.close()
        closed = broker.subscriber_count == 0
        await broker.close()
        await finished.wait()
    assert closed
    assert broker.pending_event_count == 0
