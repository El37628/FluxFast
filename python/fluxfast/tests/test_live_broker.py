"""Tests for the bounded in-memory Live Resource broker."""

from collections.abc import AsyncIterator
from typing import Any

import anyio
import anyio.lowlevel
import pytest

from fluxfast import (
    LiveBroker,
    LiveInvalidateEvent,
    LivePatchEvent,
    LiveReadyEvent,
    LiveResyncEvent,
    MemoryLiveBroker,
)


async def _receive_one(
    stream: AsyncIterator[Any],
    received: list[Any],
) -> None:
    received.append(await anext(stream))


async def _wait_for_subscribers(broker: MemoryLiveBroker, count: int) -> None:
    while broker.subscriber_count != count:
        await anyio.lowlevel.checkpoint()


@pytest.mark.anyio
async def test_publish_routes_only_to_matching_subscribers() -> None:
    broker = MemoryLiveBroker()
    alpha = broker.subscribe({"alpha"})
    beta = broker.subscribe({"beta"})
    alpha_received: list[Any] = []
    beta_received: list[Any] = []

    async with anyio.create_task_group() as tasks:
        tasks.start_soon(_receive_one, alpha, alpha_received)
        tasks.start_soon(_receive_one, beta, beta_received)
        await _wait_for_subscribers(broker, 2)
        await broker.publish("alpha", LiveInvalidateEvent(keys=["users"]))
        tasks.cancel_scope.cancel()

    assert alpha_received == [LiveInvalidateEvent(keys=["users"])]
    assert beta_received == []

    await alpha.aclose()
    await beta.aclose()
    assert broker.subscriber_count == 0


@pytest.mark.anyio
async def test_publish_fans_out_to_multiple_subscribers() -> None:
    broker = MemoryLiveBroker()
    first = broker.subscribe({"shared"})
    second = broker.subscribe({"shared"})
    first_received: list[Any] = []
    second_received: list[Any] = []
    event = LiveReadyEvent(keys=["profile"])

    async with anyio.create_task_group() as tasks:
        tasks.start_soon(_receive_one, first, first_received)
        tasks.start_soon(_receive_one, second, second_received)
        await _wait_for_subscribers(broker, 2)
        await broker.publish("shared", event)

    assert first_received == [event]
    assert second_received == [event]
    await first.aclose()
    await second.aclose()


@pytest.mark.anyio
async def test_queue_overflow_coalesces_into_resync() -> None:
    broker = MemoryLiveBroker(max_queue_size=2)
    stream = broker.subscribe({"shared"})
    received: list[Any] = []

    async with anyio.create_task_group() as tasks:
        tasks.start_soon(_receive_one, stream, received)
        await _wait_for_subscribers(broker, 1)
        await broker.publish("shared", LiveReadyEvent(keys=["profile"]))

    await broker.publish("shared", LiveInvalidateEvent(keys=["profile"]))
    await broker.publish(
        "shared",
        LivePatchEvent(
            patches={"notifications": [{"op": "replace-resource", "value": []}]}
        ),
    )
    await broker.publish("shared", LiveInvalidateEvent(keys=["settings"]))

    overflow = await anext(stream)
    assert overflow == LiveResyncEvent(
        keys=["notifications", "profile", "settings"],
        reason="overflow",
    )
    assert broker.subscriber_count == 1
    await stream.aclose()
    assert broker.subscriber_count == 0


@pytest.mark.anyio
async def test_close_wakes_and_cleans_waiting_subscribers() -> None:
    broker = MemoryLiveBroker()
    stream = broker.subscribe({"shared"})
    completed = anyio.Event()

    async def consume() -> None:
        async for _event in stream:
            pass
        completed.set()

    async with anyio.create_task_group() as tasks:
        tasks.start_soon(consume)
        await _wait_for_subscribers(broker, 1)
        await broker.close()
        await completed.wait()

    assert broker.subscriber_count == 0
    await broker.close()
    with pytest.raises(RuntimeError, match="closed"):
        await broker.publish("shared", LiveReadyEvent(keys=[]))


@pytest.mark.anyio
async def test_invalid_configuration_and_topics_are_rejected() -> None:
    for invalid_size in (0, -1, True, 1.5):
        with pytest.raises(ValueError, match="positive integer"):
            MemoryLiveBroker(max_queue_size=invalid_size)  # type: ignore[arg-type]

    broker = MemoryLiveBroker()
    for topics in (set(), {""}):
        stream = broker.subscribe(topics)
        with pytest.raises(ValueError, match="topic"):
            await anext(stream)

    with pytest.raises(ValueError, match="topic"):
        await broker.publish("", LiveReadyEvent(keys=[]))


def test_memory_broker_implements_contract() -> None:
    assert isinstance(MemoryLiveBroker(), LiveBroker)
