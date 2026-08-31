"""Optional Redis Pub/Sub broker for multi-worker Live Resources."""

from __future__ import annotations

import importlib
import logging
from collections.abc import AsyncIterator, Awaitable
from contextlib import suppress
from typing import Any, Final, Protocol

import anyio
from pydantic import TypeAdapter, ValidationError

from .events import LiveEvent

DEFAULT_REDIS_CHANNEL_PREFIX: Final = "fluxfast:v1:"
DEFAULT_REDIS_MAX_MESSAGE_BYTES: Final = 1024 * 1024
_EVENT_ADAPTER = TypeAdapter(LiveEvent)
_LOGGER = logging.getLogger("fluxfast.live.redis")


class _RedisPubSub(Protocol):
    async def subscribe(self, *channels: str) -> Any: ...

    async def unsubscribe(self, *channels: str) -> Any: ...

    async def get_message(
        self,
        *,
        ignore_subscribe_messages: bool,
        timeout: float,
    ) -> dict[str, Any] | None: ...

    def aclose(self) -> Awaitable[None]: ...


class _RedisClient(Protocol):
    async def publish(self, channel: str, message: bytes) -> Any: ...

    def pubsub(self, **kwargs: Any) -> _RedisPubSub: ...

    def aclose(self) -> Awaitable[None]: ...


def _validate_topics(topics: set[str]) -> tuple[str, ...]:
    if not isinstance(topics, set) or not topics:
        raise ValueError("a live subscription requires at least one topic")
    if any(not isinstance(topic, str) or not topic for topic in topics):
        raise ValueError("live broker topics must be non-empty strings")
    return tuple(sorted(topics))


def _load_redis_client(url: str, **kwargs: Any) -> _RedisClient:
    try:
        redis_asyncio = importlib.import_module("redis.asyncio")
    except ModuleNotFoundError as error:
        raise RuntimeError(
            'RedisLiveBroker requires the optional Redis dependency. '
            'Install it with: pip install "fluxfast[redis]"'
        ) from error
    return redis_asyncio.Redis.from_url(url, **kwargs)


class RedisLiveBroker:
    """Fan out Live Resource events across workers using Redis Pub/Sub.

    Redis messages are ephemeral synchronization signals. A Redis connection
    failure ends the affected subscription so the browser reconnects and
    performs its normal canonical resource resynchronization.
    """

    def __init__(
        self,
        client: _RedisClient,
        *,
        channel_prefix: str = DEFAULT_REDIS_CHANNEL_PREFIX,
        max_message_bytes: int = DEFAULT_REDIS_MAX_MESSAGE_BYTES,
        owns_client: bool = False,
    ) -> None:
        if not isinstance(channel_prefix, str) or not channel_prefix:
            raise ValueError("channel_prefix must be a non-empty string")
        if (
            isinstance(max_message_bytes, bool)
            or not isinstance(max_message_bytes, int)
            or max_message_bytes < 1
        ):
            raise ValueError("max_message_bytes must be a positive integer")
        self._client = client
        self.channel_prefix = channel_prefix
        self.max_message_bytes = max_message_bytes
        self._owns_client = owns_client
        self._lock = anyio.Lock()
        self._subscriptions: set[_RedisPubSub] = set()
        self._closed = False

    @classmethod
    def from_url(
        cls,
        url: str,
        *,
        channel_prefix: str = DEFAULT_REDIS_CHANNEL_PREFIX,
        max_message_bytes: int = DEFAULT_REDIS_MAX_MESSAGE_BYTES,
        **redis_options: Any,
    ) -> RedisLiveBroker:
        """Create an owned async Redis client without importing Redis eagerly."""

        if not isinstance(url, str) or not url:
            raise ValueError("Redis URL must be a non-empty string")
        client = _load_redis_client(url, **redis_options)
        return cls(
            client,
            channel_prefix=channel_prefix,
            max_message_bytes=max_message_bytes,
            owns_client=True,
        )

    @property
    def subscriber_count(self) -> int:
        """Return subscriptions owned by this broker process."""

        return len(self._subscriptions)

    async def publish(self, topic: str, event: LiveEvent) -> None:
        """Publish one validated event to an opaque Redis channel."""

        if not isinstance(topic, str) or not topic:
            raise ValueError("live broker topics must be non-empty strings")
        async with self._lock:
            if self._closed:
                raise RuntimeError("live broker is closed")
        payload = event.model_dump_json(exclude_none=True).encode()
        if len(payload) > self.max_message_bytes:
            raise ValueError(
                f"live broker message exceeds {self.max_message_bytes} bytes"
            )
        await self._client.publish(self._channel(topic), payload)

    async def subscribe(self, topics: set[str]) -> AsyncIterator[LiveEvent]:
        """Subscribe through a dedicated Redis Pub/Sub connection."""

        normalized_topics = _validate_topics(topics)
        channels = tuple(self._channel(topic) for topic in normalized_topics)
        pubsub = self._client.pubsub(ignore_subscribe_messages=True)
        async with self._lock:
            if self._closed:
                await pubsub.aclose()
                raise RuntimeError("live broker is closed")

        try:
            await pubsub.subscribe(*channels)
            async with self._lock:
                if self._closed:
                    return
                self._subscriptions.add(pubsub)

            while True:
                try:
                    message = await pubsub.get_message(
                        ignore_subscribe_messages=True,
                        timeout=1.0,
                    )
                # redis-py and provider transports expose several exception
                # families; every disconnect follows the same safe recovery.
                except Exception as error:  # noqa: BLE001
                    async with self._lock:
                        if self._closed:
                            return
                    _LOGGER.warning(
                        "Redis live subscription disconnected; browser reconnect will resynchronize",
                        extra={
                            "fluxfast_live_error_type": type(error).__name__,
                        },
                    )
                    return
                if message is None or message.get("type") != "message":
                    await anyio.lowlevel.checkpoint()
                    continue
                payload = message.get("data")
                if isinstance(payload, str):
                    encoded = payload.encode()
                elif isinstance(payload, bytes):
                    encoded = payload
                else:
                    raise TypeError("Redis live message must contain text or bytes")
                if len(encoded) > self.max_message_bytes:
                    raise ValueError(
                        f"live broker message exceeds {self.max_message_bytes} bytes"
                    )
                try:
                    yield _EVENT_ADAPTER.validate_json(encoded)
                except ValidationError as error:
                    raise ValueError("Redis live message is not a valid event") from error
        finally:
            async with self._lock:
                self._subscriptions.discard(pubsub)
            with anyio.CancelScope(shield=True):
                with suppress(Exception):
                    await pubsub.unsubscribe(*channels)
                await pubsub.aclose()

    async def close(self) -> None:
        """Close subscriptions and the owned Redis client idempotently."""

        async with self._lock:
            if self._closed:
                return
            self._closed = True
            subscriptions = tuple(self._subscriptions)
            self._subscriptions.clear()

        for pubsub in subscriptions:
            with anyio.CancelScope(shield=True):
                await pubsub.aclose()
        if self._owns_client:
            await self._client.aclose()

    def _channel(self, topic: str) -> str:
        return f"{self.channel_prefix}{topic}"
