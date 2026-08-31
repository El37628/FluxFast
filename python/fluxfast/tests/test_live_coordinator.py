"""Tests for scoped Live Resource coordination."""

import logging
import time
from collections.abc import AsyncIterator
from typing import Any

import anyio
import anyio.lowlevel
import pytest
from fastapi import FastAPI

from fluxfast import (
    CachedResource,
    FluxFast,
    FluxFastLiveScopeError,
    LiveCoordinator,
    LiveEvent,
    LiveInvalidateEvent,
    LiveMetrics,
    LivePatchEvent,
    LiveResyncEvent,
    MemoryLiveBroker,
    MemoryResourceCache,
    Page,
    ResourceCacheUnavailableError,
    append_item,
    derive_live_topic,
    resource,
    scope,
)


async def _receive_one(
    stream: AsyncIterator[LiveEvent],
    received: list[LiveEvent],
) -> None:
    received.append(await anext(stream))


async def _wait_for_subscriber(broker: MemoryLiveBroker) -> None:
    while broker.subscriber_count != 1:
        await anyio.lowlevel.checkpoint()


def test_topic_derivation_is_opaque_deterministic_and_scoped() -> None:
    alice = derive_live_topic(scope.user("alice@example.com"), "notifications")

    assert alice == derive_live_topic(
        scope.user("alice@example.com"), "notifications"
    )
    assert alice.startswith("fluxfast.live.")
    assert "alice" not in alice
    assert "notifications" not in alice
    assert alice != derive_live_topic(scope.user("bob@example.com"), "notifications")
    assert alice != derive_live_topic(scope.tenant("alice@example.com"), "notifications")
    assert alice != derive_live_topic(scope.user("alice@example.com"), "profile")


def test_topic_derivation_requires_safe_key_and_reusable_scope() -> None:
    with pytest.raises(FluxFastLiveScopeError, match="reusable scope"):
        derive_live_topic(scope.request(), "profile")
    with pytest.raises(ValueError, match="safe non-empty"):
        derive_live_topic(scope.public(), "bad,key")


def test_subscription_uses_only_authoritative_live_declarations() -> None:
    coordinator = LiveCoordinator(MemoryResourceCache(), MemoryLiveBroker())
    page = Page(
        "Dashboard",
        resources=[
            resource("public", lambda: 1, scope=scope.public(), live=True),
            resource("private", lambda: 2, scope=scope.user("alice"), live=True),
            resource("static", lambda: 3),
        ],
    )

    subscription = coordinator.resolve_subscription(
        page,
        {"private", "static", "invented"},
    )

    assert subscription.keys == ("private",)
    assert subscription.topics == frozenset(
        {derive_live_topic(scope.user("alice"), "private")}
    )

    empty = coordinator.resolve_subscription(page, {"invented"})
    with pytest.raises(ValueError, match="declared by this page"):
        coordinator.subscribe(empty)


def test_subscription_topics_isolate_users_tenants_and_custom_scopes() -> None:
    coordinator = LiveCoordinator(MemoryResourceCache(), MemoryLiveBroker())

    def topic_for(resource_scope: Any) -> frozenset[str]:
        page = Page(
            "Dashboard",
            [resource("summary", lambda: 1, scope=resource_scope, live=True)],
        )
        return coordinator.resolve_subscription(page, {"summary"}).topics

    topics = {
        next(iter(topic_for(scope.public()))),
        next(iter(topic_for(scope.user("1")))),
        next(iter(topic_for(scope.user("2")))),
        next(iter(topic_for(scope.tenant("1")))),
        next(iter(topic_for(scope.tenant("2")))),
        next(iter(topic_for(scope.custom("organization", "1")))),
        next(iter(topic_for(scope.custom("organization", "2")))),
    }
    assert len(topics) == 7


@pytest.mark.anyio
async def test_manual_invalidation_deletes_cache_before_publishing() -> None:
    cache = MemoryResourceCache()
    broker = MemoryLiveBroker()
    coordinator = LiveCoordinator(cache, broker)
    resource_scope = scope.tenant("hotel-1")
    cache_key = f"{resource_scope.fingerprint()}::summary"
    await cache.set(
        cache_key,
        CachedResource("v1", {"count": 1}, time.monotonic() + 60),
        60,
    )
    subscription = coordinator.resolve_subscription(
        Page(
            "Dashboard",
            [resource("summary", dict, scope=resource_scope, live=True)],
        ),
        {"summary"},
    )
    stream = coordinator.subscribe(subscription)
    received: list[LiveEvent] = []

    async with anyio.create_task_group() as tasks:
        tasks.start_soon(_receive_one, stream, received)
        await _wait_for_subscriber(broker)
        await coordinator.invalidate(
            "summary",
            scope=resource_scope,
            origin_client_id="ff_origin",
        )

    assert await cache.get(cache_key) is None
    assert received == [
        LiveInvalidateEvent(keys=["summary"], originClientId="ff_origin")
    ]
    await stream.aclose()


@pytest.mark.anyio
async def test_failed_cache_invalidation_never_publishes_live_signal() -> None:
    published: list[tuple[str, LiveEvent]] = []

    class FailingCache(MemoryResourceCache):
        async def delete(self, key: str) -> None:
            raise ResourceCacheUnavailableError("shared cache unavailable")

    class RecordingBroker(MemoryLiveBroker):
        async def publish(self, topic: str, event: LiveEvent) -> None:
            published.append((topic, event))

    coordinator = LiveCoordinator(FailingCache(), RecordingBroker())

    with pytest.raises(ResourceCacheUnavailableError, match="unavailable"):
        await coordinator.invalidate("rooms", scope=scope.tenant("hotel-1"))

    assert published == []


@pytest.mark.anyio
async def test_manual_patch_validates_deletes_cache_and_publishes() -> None:
    cache = MemoryResourceCache()
    broker = MemoryLiveBroker()
    coordinator = LiveCoordinator(cache, broker)
    resource_scope = scope.user("alice")
    cache_key = f"{resource_scope.fingerprint()}::rooms"
    await cache.set(
        cache_key,
        CachedResource("v1", [], time.monotonic() + 60),
        60,
    )
    subscription = coordinator.resolve_subscription(
        Page(
            "Rooms",
            [resource("rooms", list, scope=resource_scope, live=True)],
        ),
        {"rooms"},
    )
    stream = coordinator.subscribe(subscription)
    received: list[LiveEvent] = []
    patches = [append_item({"id": 2})]

    async with anyio.create_task_group() as tasks:
        tasks.start_soon(_receive_one, stream, received)
        await _wait_for_subscriber(broker)
        await coordinator.patch(
            "rooms",
            patches,
            scope=resource_scope,
            origin_client_id="ff_origin",
        )

    assert await cache.get(cache_key) is None
    assert received == [
        LivePatchEvent(
            patches={"rooms": patches},
            originClientId="ff_origin",
        )
    ]
    await stream.aclose()


def test_fluxfast_wires_default_or_custom_live_broker() -> None:
    default_flux = FluxFast(FastAPI())
    assert isinstance(default_flux.live.broker, MemoryLiveBroker)
    assert default_flux.app.state.fluxfast_live is default_flux.live
    assert default_flux.live.metrics is default_flux.live_metrics
    assert default_flux.app.state.fluxfast_live_metrics is default_flux.live_metrics

    custom_broker = MemoryLiveBroker(max_queue_size=5)
    custom_flux = FluxFast(FastAPI(), broker=custom_broker)
    assert custom_flux.live.broker is custom_broker

    positional_debug = FluxFast(FastAPI(), None, True)
    assert positional_debug.debug is True

    named_broker = MemoryLiveBroker()
    named_flux = FluxFast(FastAPI(), live_broker=named_broker)
    assert named_flux.live.broker is named_broker

    with pytest.raises(ValueError, match="either broker or live_broker"):
        FluxFast(
            FastAPI(),
            broker=MemoryLiveBroker(),
            live_broker=MemoryLiveBroker(),
        )


@pytest.mark.anyio
async def test_live_metrics_track_connections_publications_and_resyncs() -> None:
    metrics = LiveMetrics()
    broker = MemoryLiveBroker(max_queue_size=1)
    coordinator = LiveCoordinator(MemoryResourceCache(), broker, metrics=metrics)
    resource_scope = scope.public()
    subscription = coordinator.resolve_subscription(
        Page(
            "Dashboard",
            [resource("summary", dict, scope=resource_scope, live=True)],
        ),
        {"summary"},
    )
    stream = coordinator.subscribe(subscription)
    received: list[LiveEvent] = []

    async with anyio.create_task_group() as tasks:
        tasks.start_soon(_receive_one, stream, received)
        await _wait_for_subscriber(broker)
        snapshot = metrics.snapshot()
        assert snapshot.live_connections_active == 1
        assert snapshot.live_connections_total == 1
        await coordinator.invalidate("summary", scope=resource_scope)

    await coordinator.patch(
        "summary",
        [{"op": "replace-resource", "value": {"count": 2}}],
        scope=resource_scope,
    )
    await coordinator.invalidate("summary", scope=resource_scope)
    assert broker.queue_overflow_count == 1
    overflow = await anext(stream)
    assert overflow == LiveResyncEvent(keys=["summary"], reason="overflow")
    await stream.aclose()

    snapshot = metrics.snapshot()
    assert snapshot.as_dict() == {
        "live_connections_active": 0,
        "live_connections_total": 1,
        "live_events_published": 3,
        "live_invalidations_published": 2,
        "live_patches_published": 1,
        "live_resyncs": 1,
        "live_queue_overflows": 1,
        "live_publish_errors": 0,
    }


@pytest.mark.anyio
async def test_publish_failure_keeps_invalidated_canonical_state(
    caplog: pytest.LogCaptureFixture,
) -> None:
    class FailingBroker:
        async def publish(self, topic: str, event: LiveEvent) -> None:
            raise ConnectionError(
                "redis://service-user:super-secret@example.invalid unavailable"
            )

        async def subscribe(self, topics: set[str]) -> AsyncIterator[LiveEvent]:
            yield LiveInvalidateEvent(keys=[])

        async def close(self) -> None:
            pass

    cache = MemoryResourceCache()
    coordinator = LiveCoordinator(cache, FailingBroker())
    resource_scope = scope.tenant("hotel-1")
    cache_key = f"{resource_scope.fingerprint()}::summary"
    await cache.set(
        cache_key,
        CachedResource("v1", {"count": 1}, time.monotonic() + 60),
        60,
    )

    with caplog.at_level(logging.ERROR, logger="fluxfast.live"):
        await coordinator.invalidate("summary", scope=resource_scope)

    assert await cache.get(cache_key) is None
    assert "publication failed" in caplog.text
    assert "service-user" not in caplog.text
    assert "super-secret" not in caplog.text
    assert "example.invalid" not in caplog.text
    assert caplog.records[-1].fluxfast_live_error_type == "ConnectionError"
    assert coordinator.metrics.snapshot().live_publish_errors == 1
