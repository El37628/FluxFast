"""Framework-neutral broker contract for Live Resource events."""

from collections.abc import AsyncIterator
from typing import Protocol, runtime_checkable

from .events import LiveEvent


@runtime_checkable
class LiveBroker(Protocol):
    """Transport-independent fan-out contract used by the live coordinator."""

    async def publish(self, topic: str, event: LiveEvent) -> None:
        """Publish an event to every active subscriber of ``topic``."""

        ...

    def subscribe(self, topics: set[str]) -> AsyncIterator[LiveEvent]:
        """Yield events published to any of ``topics`` until disconnected."""

        ...

    async def close(self) -> None:
        """Close the broker and release all active subscriptions."""

        ...
