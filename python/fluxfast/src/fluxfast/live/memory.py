"""Bounded, single-process Live Resource broker."""

from __future__ import annotations

from collections import deque
from collections.abc import AsyncIterator, Iterable
from dataclasses import dataclass, field
from typing import Final

import anyio

from .events import (
    MAX_LIVE_EVENT_KEYS,
    LiveEvent,
    LivePatchEvent,
    LiveResyncEvent,
)

DEFAULT_LIVE_QUEUE_SIZE: Final = 64


@dataclass(eq=False, slots=True)
class _Subscriber:
    topics: frozenset[str]
    condition: anyio.Condition = field(default_factory=anyio.Condition)
    events: deque[LiveEvent] = field(default_factory=deque)
    closed: bool = False


def _event_keys(event: LiveEvent) -> set[str]:
    if isinstance(event, LivePatchEvent):
        return set(event.patches)
    return set(event.keys)


def _validate_topics(topics: Iterable[str]) -> frozenset[str]:
    normalized = frozenset(topics)
    if not normalized:
        raise ValueError("a live subscription requires at least one topic")
    if any(not isinstance(topic, str) or not topic for topic in normalized):
        raise ValueError("live broker topics must be non-empty strings")
    return normalized


class MemoryLiveBroker:
    """Async-safe, bounded broker for a single Python process.

    Events are not persisted or shared with other workers. When a subscriber
    falls behind, queued events are replaced by one canonical resync signal.
    If the accumulated key set cannot fit the wire limit, the subscription is
    closed so its transport can reconnect and reconstruct authoritative state.
    """

    def __init__(self, *, max_queue_size: int = DEFAULT_LIVE_QUEUE_SIZE) -> None:
        if (
            isinstance(max_queue_size, bool)
            or not isinstance(max_queue_size, int)
            or max_queue_size < 1
        ):
            raise ValueError("max_queue_size must be a positive integer")
        self.max_queue_size = max_queue_size
        self._lock = anyio.Lock()
        self._subscribers: set[_Subscriber] = set()
        self._closed = False
        self._queue_overflow_count = 0

    @property
    def subscriber_count(self) -> int:
        """Return the current in-process subscriber count."""

        return len(self._subscribers)

    @property
    def pending_event_count(self) -> int:
        """Return the aggregate number of events queued for slow subscribers."""

        return sum(len(subscriber.events) for subscriber in self._subscribers)

    @property
    def queue_overflow_count(self) -> int:
        """Return how often a full subscriber queue required recovery."""

        return self._queue_overflow_count

    async def publish(self, topic: str, event: LiveEvent) -> None:
        """Fan out an event without allowing a slow subscriber to block."""

        if not isinstance(topic, str) or not topic:
            raise ValueError("live broker topics must be non-empty strings")

        async with self._lock:
            if self._closed:
                raise RuntimeError("live broker is closed")
            subscribers = tuple(
                subscriber
                for subscriber in self._subscribers
                if topic in subscriber.topics
            )

        for subscriber in subscribers:
            async with subscriber.condition:
                if subscriber.closed:
                    continue
                if len(subscriber.events) < self.max_queue_size:
                    subscriber.events.append(event)
                else:
                    self._queue_overflow_count += 1
                    keys = _event_keys(event)
                    for queued_event in subscriber.events:
                        keys.update(_event_keys(queued_event))
                    subscriber.events.clear()
                    if len(keys) > MAX_LIVE_EVENT_KEYS:
                        subscriber.closed = True
                    else:
                        subscriber.events.append(
                            LiveResyncEvent(keys=sorted(keys), reason="overflow")
                        )
                subscriber.condition.notify()

    async def subscribe(self, topics: set[str]) -> AsyncIterator[LiveEvent]:
        """Subscribe to a set of opaque topics until closed or cancelled."""

        subscriber = _Subscriber(topics=_validate_topics(topics))
        async with self._lock:
            if self._closed:
                raise RuntimeError("live broker is closed")
            self._subscribers.add(subscriber)

        try:
            while True:
                async with subscriber.condition:
                    while not subscriber.events and not subscriber.closed:
                        await subscriber.condition.wait()
                    if subscriber.closed:
                        return
                    event = subscriber.events.popleft()
                yield event
        finally:
            with anyio.CancelScope(shield=True):
                async with self._lock:
                    self._subscribers.discard(subscriber)
                async with subscriber.condition:
                    subscriber.closed = True
                    subscriber.events.clear()
                    subscriber.condition.notify_all()

    async def close(self) -> None:
        """Stop all subscriptions. Calling close more than once is safe."""

        async with self._lock:
            if self._closed:
                return
            self._closed = True
            subscribers = tuple(self._subscribers)
            self._subscribers.clear()

        for subscriber in subscribers:
            async with subscriber.condition:
                subscriber.closed = True
                subscriber.events.clear()
                subscriber.condition.notify_all()
