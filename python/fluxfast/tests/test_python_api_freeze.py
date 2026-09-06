"""v0.9 Python public-API classification and behavior freeze."""

from __future__ import annotations

import re
from pathlib import Path

import pytest
from fastapi import FastAPI

import fluxfast
from fluxfast import (
    CacheScope,
    FluxFast,
    InvalidateResource,
    LiveCoordinator,
    LiveMetrics,
    MemoryLiveBroker,
    MemoryResourceCache,
    RedisCacheMetrics,
    RedisLiveBroker,
    RedisResourceCache,
    ResourceContract,
    ScopeType,
    TypeContract,
    append_item,
    flux_external_redirect,
    flux_redirect,
    invalidate_resource,
    merge_object,
    mutation,
    remove_item,
    replace_item,
    replace_resource,
    resource,
    scope,
)

_API_DOC_PATH = Path(__file__).resolve().parents[3] / "docs" / "python-api.md"
_TABLE_START = "<!-- python-api-export-table:start -->"
_TABLE_END = "<!-- python-api-export-table:end -->"
_CLASSIFICATION_ROW = re.compile(
    r"^\| `(?P<name>[^`]+)` \| "
    r"(?P<classification>Stable Candidate|Advanced Stable Candidate|Deprecated) \|"
)


def _documented_classifications() -> dict[str, str]:
    document = _API_DOC_PATH.read_text(encoding="utf8")
    table = document.split(_TABLE_START, 1)[1].split(_TABLE_END, 1)[0]
    rows = [
        match.groupdict()
        for line in table.splitlines()
        if (match := _CLASSIFICATION_ROW.match(line)) is not None
    ]
    names = [row["name"] for row in rows]
    assert len(names) == len(set(names)), "public API classification has duplicates"
    return {row["name"]: row["classification"] for row in rows}


def test_every_top_level_export_has_one_v09_classification() -> None:
    classifications = _documented_classifications()

    assert set(classifications) == set(fluxfast.__all__)
    assert set(classifications.values()) == {
        "Stable Candidate",
        "Advanced Stable Candidate",
        "Deprecated",
    }
    assert all(hasattr(fluxfast, name) for name in classifications)


def test_low_level_and_compatibility_exports_are_intentionally_classified() -> None:
    classifications = _documented_classifications()

    assert {
        name
        for name, classification in classifications.items()
        if classification == "Deprecated"
    } == {"PageNotFoundError", "ValidationError"}
    assert {
        name: classifications[name]
        for name in (
            "LiveCoordinator",
            "derive_live_topic",
            "encode_sse_event",
            "iter_live_events",
            "LiveSubscription",
            "PageEnvelope",
            "RedisCacheMetrics",
            "RedisCacheMetricsSnapshot",
            "PROTOCOL_VERSION",
            "HEADER_CAPABILITIES",
        )
    } == {
        "LiveCoordinator": "Advanced Stable Candidate",
        "derive_live_topic": "Advanced Stable Candidate",
        "encode_sse_event": "Advanced Stable Candidate",
        "iter_live_events": "Advanced Stable Candidate",
        "LiveSubscription": "Advanced Stable Candidate",
        "PageEnvelope": "Advanced Stable Candidate",
        "RedisCacheMetrics": "Advanced Stable Candidate",
        "RedisCacheMetricsSnapshot": "Advanced Stable Candidate",
        "PROTOCOL_VERSION": "Advanced Stable Candidate",
        "HEADER_CAPABILITIES": "Advanced Stable Candidate",
    }


def test_application_contract_and_decorator_behavior_is_frozen() -> None:
    app = FastAPI()
    flux = FluxFast(app)

    assert isinstance(flux.cache, MemoryResourceCache)
    assert isinstance(flux.live.broker, MemoryLiveBroker)
    assert app.state.fluxfast_cache is flux.cache
    assert app.state.fluxfast_live is flux.live

    rooms = flux.define_resource("rooms", list[int])
    form = flux.define_type("RoomForm", dict[str, int], mode="validation")

    assert isinstance(rooms, ResourceContract)
    assert (rooms.key, rooms.annotation) == ("rooms", list[int])
    assert isinstance(form, TypeContract)
    assert (form.name, form.annotation, form.mode) == (
        "RoomForm",
        dict[str, int],
        "validation",
    )

    @flux.page("/api-freeze")
    async def frozen_page() -> str:
        return "page"

    @flux.mutation("/api-freeze", methods=["PATCH", "POST"])
    async def frozen_mutation() -> str:
        return "mutation"

    assert frozen_page.__name__ == "frozen_page"
    assert frozen_mutation.__name__ == "frozen_mutation"
    route_methods = {
        frozenset(route.methods or ())
        for route in app.routes
        if getattr(route, "path", None) == "/api-freeze"
    }
    assert route_methods == {frozenset({"GET"}), frozenset({"PATCH", "POST"})}

    named_broker = MemoryLiveBroker()
    named_flux = FluxFast(FastAPI(), live_broker=named_broker)
    assert named_flux.live.broker is named_broker

    with pytest.raises(ValueError, match="either broker or live_broker"):
        FluxFast(
            FastAPI(),
            broker=MemoryLiveBroker(),
            live_broker=MemoryLiveBroker(),
        )


def test_resource_and_scope_builder_behavior_is_frozen() -> None:
    flux = FluxFast(FastAPI())
    rooms = flux.define_resource("rooms", list[int])
    tenant_scope = scope.tenant(42)
    spec = resource(
        rooms,
        lambda: [101],
        scope=tenant_scope,
        ttl=30,
        tags=["rooms", "availability"],
        defer=True,
        live=True,
    )

    assert spec.key == "rooms"
    assert spec.contract is rooms
    assert spec.scope == tenant_scope
    assert spec.ttl == 30
    assert spec.tags == ("rooms", "availability")
    assert spec.defer is True
    assert spec.live is True

    public_scope = scope.public()
    user_scope = scope.user("alice/bob")
    request_scope = scope.request()
    custom_scope = scope.custom("organization", "north/east")

    assert public_scope == CacheScope(ScopeType.PUBLIC)
    assert public_scope.fingerprint() == "public"
    assert user_scope.fingerprint() == "user:alice%2Fbob"
    assert tenant_scope.fingerprint() == "tenant:42"
    assert custom_scope.fingerprint() == "custom:organization:north%2Feast"
    assert request_scope.fingerprint().startswith("request:")
    assert request_scope.is_cacheable is False
    assert all(
        reusable.is_cacheable
        for reusable in (public_scope, user_scope, tenant_scope, custom_scope)
    )

    request_default = resource("request-data", lambda: 1, ttl=30)
    assert request_default.scope.scope_type is ScopeType.REQUEST


def test_mutation_builder_and_compatibility_spellings_are_frozen() -> None:
    operations = [
        replace_resource([]),
        merge_object({"total": 1}),
        replace_item(1, {"id": 1}),
        remove_item("old"),
        append_item({"id": 2}),
    ]
    expected_operations = [
        {"op": "replace-resource", "value": []},
        {"op": "merge-object", "value": {"total": 1}},
        {"op": "replace-item", "id": 1, "value": {"id": 1}},
        {"op": "remove-item", "id": "old"},
        {"op": "append-item", "value": {"id": 2}},
    ]
    assert operations == expected_operations

    invalidation = invalidate_resource("rooms", scope.tenant("hotel-1"))
    plural = mutation(
        patches={"rooms": operations},
        invalidates=[invalidation, "summary"],
        redirect="/rooms",
    )
    singular = mutation(
        patch={"rooms": operations},
        invalidate=[invalidation, "summary"],
        redirect="/rooms",
    )

    assert plural == singular
    assert plural.patches == {"rooms": expected_operations}
    assert plural.invalidate == [
        invalidation,
        InvalidateResource(key="summary"),
    ]
    assert plural.redirect == "/rooms"
    assert flux_redirect("/rooms").redirect == "/rooms"
    assert (
        flux_external_redirect("https://example.com/login").external_redirect
        == "https://example.com/login"
    )

    with pytest.raises(ValueError, match="either patch or patches"):
        mutation(patch={}, patches={})
    with pytest.raises(ValueError, match="either invalidate or invalidates"):
        mutation(invalidate=[], invalidates=[])


def test_cache_and_broker_constructor_behavior_is_frozen() -> None:
    redis_client = object()
    cache_metrics = RedisCacheMetrics()
    redis_cache = RedisResourceCache(
        redis_client,  # type: ignore[arg-type]
        namespace="api-freeze",
        max_value_bytes=4096,
        scan_count=25,
        metrics=cache_metrics,
    )
    live_metrics = LiveMetrics()
    memory_broker = MemoryLiveBroker(max_queue_size=8, metrics=live_metrics)
    redis_broker = RedisLiveBroker(
        redis_client,  # type: ignore[arg-type]
        channel_prefix="fluxfast:api-freeze:live:",
        max_message_bytes=8192,
    )
    coordinator = LiveCoordinator(redis_cache, memory_broker, metrics=live_metrics)

    assert redis_cache.scan_count == 25
    assert redis_cache.metrics is cache_metrics
    assert memory_broker.max_queue_size == 8
    assert redis_broker.channel_prefix == "fluxfast:api-freeze:live:"
    assert redis_broker.max_message_bytes == 8192
    assert coordinator.cache is redis_cache
    assert coordinator.broker is memory_broker
    assert coordinator.metrics is live_metrics

    with pytest.raises(ValueError, match="greater than zero"):
        MemoryResourceCache(max_entries=0)
    with pytest.raises(ValueError, match="positive integer"):
        MemoryLiveBroker(max_queue_size=0)
    with pytest.raises(ValueError, match="non-empty string"):
        RedisLiveBroker(redis_client, channel_prefix="")  # type: ignore[arg-type]
