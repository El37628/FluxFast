"""Unit coverage for the optional Redis Live Resource broker."""

from __future__ import annotations

import logging
from typing import Any

import pytest

import fluxfast.live.redis as redis_module
from fluxfast import (
    LiveBroker,
    LiveInvalidateEvent,
    RedisLiveBroker,
)


class RecordingRedisClient:
    def __init__(self) -> None:
        self.published: list[tuple[str, bytes]] = []
        self.closed = False

    async def publish(self, channel: str, message: bytes) -> int:
        self.published.append((channel, message))
        return 1

    def pubsub(self, **kwargs: Any) -> Any:
        raise AssertionError("this test does not subscribe")

    async def aclose(self) -> None:
        self.closed = True


class FailingRedisClient(RecordingRedisClient):
    async def publish(self, channel: str, message: bytes) -> int:
        raise ConnectionError("Redis unavailable")


class DisconnectingPubSub:
    def __init__(self) -> None:
        self.subscribed: tuple[str, ...] = ()
        self.unsubscribed: tuple[str, ...] = ()
        self.closed = False

    async def subscribe(self, *channels: str) -> None:
        self.subscribed = channels

    async def unsubscribe(self, *channels: str) -> None:
        self.unsubscribed = channels

    async def get_message(self, **_kwargs: Any) -> None:
        raise ConnectionError(
            "redis://service-user:super-secret@example.invalid unavailable"
        )

    async def aclose(self) -> None:
        self.closed = True


class DisconnectingRedisClient(RecordingRedisClient):
    def __init__(self) -> None:
        super().__init__()
        self.pubsub_client = DisconnectingPubSub()

    def pubsub(self, **_kwargs: Any) -> DisconnectingPubSub:
        return self.pubsub_client


@pytest.mark.anyio
async def test_redis_broker_serializes_to_prefixed_ephemeral_channel() -> None:
    client = RecordingRedisClient()
    broker = RedisLiveBroker(client, channel_prefix="application:")
    event = LiveInvalidateEvent(keys=["summary"], originClientId="ff_other")

    await broker.publish("opaque-topic", event)

    assert client.published == [
        (
            "application:opaque-topic",
            b'{"protocol":"fluxfast/1","type":"invalidate","keys":["summary"],"originClientId":"ff_other"}',
        )
    ]
    assert isinstance(broker, LiveBroker)
    await broker.close()
    assert client.closed is False


@pytest.mark.anyio
async def test_owned_redis_client_closes_and_publish_after_close_fails() -> None:
    client = RecordingRedisClient()
    broker = RedisLiveBroker(client, owns_client=True)

    await broker.close()
    await broker.close()

    assert client.closed is True
    with pytest.raises(RuntimeError, match="closed"):
        await broker.publish("topic", LiveInvalidateEvent(keys=["summary"]))


@pytest.mark.anyio
async def test_publish_failure_is_exposed_to_the_coordinator() -> None:
    broker = RedisLiveBroker(FailingRedisClient())

    with pytest.raises(ConnectionError, match="unavailable"):
        await broker.publish("topic", LiveInvalidateEvent(keys=["summary"]))


@pytest.mark.anyio
async def test_subscription_disconnect_log_omits_redis_credentials(
    caplog: pytest.LogCaptureFixture,
) -> None:
    client = DisconnectingRedisClient()
    broker = RedisLiveBroker(client, channel_prefix="application:")
    stream = broker.subscribe({"opaque-topic"})

    with (
        caplog.at_level(logging.WARNING, logger="fluxfast.live.redis"),
        pytest.raises(StopAsyncIteration),
    ):
        await anext(stream)

    assert "subscription disconnected" in caplog.text
    assert "service-user" not in caplog.text
    assert "super-secret" not in caplog.text
    assert "example.invalid" not in caplog.text
    assert caplog.records[-1].fluxfast_live_error_type == "ConnectionError"
    assert client.pubsub_client.subscribed == ("application:opaque-topic",)
    assert client.pubsub_client.unsubscribed == ("application:opaque-topic",)
    assert client.pubsub_client.closed is True


def test_from_url_explains_how_to_install_optional_dependency(monkeypatch: Any) -> None:
    def missing_redis(_name: str) -> Any:
        raise ModuleNotFoundError("No module named 'redis'")

    monkeypatch.setattr(redis_module.importlib, "import_module", missing_redis)

    with pytest.raises(RuntimeError, match=r'pip install "fluxfast\[redis\]"'):
        RedisLiveBroker.from_url("redis://localhost:6379/0")


@pytest.mark.parametrize(
    ("kwargs", "message"),
    [
        ({"channel_prefix": ""}, "channel_prefix"),
        ({"max_message_bytes": 0}, "positive integer"),
        ({"max_message_bytes": True}, "positive integer"),
    ],
)
def test_invalid_redis_broker_configuration_is_rejected(
    kwargs: dict[str, Any],
    message: str,
) -> None:
    with pytest.raises(ValueError, match=message):
        RedisLiveBroker(RecordingRedisClient(), **kwargs)


def test_redis_module_does_not_import_optional_client_at_module_import() -> None:
    # The fake client satisfies the structural dependency without redis-py.
    broker = RedisLiveBroker(RecordingRedisClient())
    assert broker.subscriber_count == 0
