"""Server-Sent Event framing and lifecycle for Live Resources."""

from __future__ import annotations

import json
from collections.abc import AsyncIterator
from typing import Final

import anyio
import anyio.lowlevel

from .coordinator import LiveCoordinator, LiveSubscription
from .events import LIVE_EVENT_NAME, LiveEvent, LiveReadyEvent

DEFAULT_LIVE_HEARTBEAT_INTERVAL: Final = 15.0
DEFAULT_LIVE_MAX_CONNECTION_AGE: Final = 15 * 60.0
LIVE_HEARTBEAT: Final = b": ping\n\n"


def encode_sse_event(event: LiveEvent) -> bytes:
    """Encode one validated live event as a named SSE frame."""

    payload = json.dumps(
        event.model_dump(mode="json", exclude_none=True),
        separators=(",", ":"),
    )
    return f"event: {LIVE_EVENT_NAME}\ndata: {payload}\n\n".encode()


async def iter_live_events(
    coordinator: LiveCoordinator,
    subscription: LiveSubscription,
    *,
    heartbeat_interval: float = DEFAULT_LIVE_HEARTBEAT_INTERVAL,
    max_connection_age: float = DEFAULT_LIVE_MAX_CONNECTION_AGE,
) -> AsyncIterator[bytes]:
    """Stream a ready event, broker events, heartbeats, then close at max age."""

    send_events, receive_events = anyio.create_memory_object_stream[LiveEvent](1)

    async def pump_broker_events() -> None:
        async with send_events:
            async for event in coordinator.subscribe(subscription):
                await send_events.send(event)

    started_at = anyio.current_time()
    async with receive_events, anyio.create_task_group() as tasks:
        tasks.start_soon(pump_broker_events)
        # Let the broker subscription enter its receive loop before announcing
        # readiness, avoiding a publication gap for the memory implementation.
        await anyio.lowlevel.checkpoint()
        try:
            yield encode_sse_event(LiveReadyEvent(keys=list(subscription.keys)))

            while True:
                remaining = max_connection_age - (anyio.current_time() - started_at)
                if remaining <= 0:
                    return
                timeout = min(heartbeat_interval, remaining)
                event: LiveEvent | None = None
                stream_ended = False
                with anyio.move_on_after(timeout) as receive_scope:
                    try:
                        event = await receive_events.receive()
                    except anyio.EndOfStream:
                        stream_ended = True

                if stream_ended:
                    return
                if event is not None:
                    yield encode_sse_event(event)
                    continue
                if not receive_scope.cancel_called:
                    continue
                if anyio.current_time() - started_at >= max_connection_age:
                    return
                yield LIVE_HEARTBEAT
        except GeneratorExit:
            return
        finally:
            tasks.cancel_scope.cancel()
