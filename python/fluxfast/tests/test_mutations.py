"""Tests for mutation building, patching, invalidation, and redirects."""

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from fluxfast import (
    FluxFast,
    LiveInvalidateEvent,
    append_item,
    derive_live_topic,
    flux_external_redirect,
    flux_redirect,
    invalidate_resource,
    merge_object,
    mutation,
    remove_item,
    replace_item,
    replace_resource,
    scope,
)
from fluxfast.headers import HEADER_CLIENT_ID, HEADER_FLUXFAST


class RecordingCache:
    def __init__(self):
        self.deleted: list[str] = []

    async def delete(self, key: str) -> None:
        self.deleted.append(key)


class RecordingBroker:
    def __init__(self):
        self.published: list[tuple[str, LiveInvalidateEvent]] = []

    async def publish(self, topic: str, event: LiveInvalidateEvent) -> None:
        self.published.append((topic, event))


def test_mutation_envelope_building():
    res = mutation(
        patch={
            "rooms": [
                {"op": "replace-item", "id": 101, "value": {"id": 101, "status": "clean"}}
            ]
        },
        invalidate=["summary", invalidate_resource("rooms", scope=scope.tenant(1))],
        redirect="/rooms",
    )

    envelope = res.to_envelope()
    assert envelope.protocol == "fluxfast/1"
    assert envelope.mutation.redirect == "/rooms"
    assert "summary" in (envelope.mutation.invalidate or [])
    assert "rooms" in (envelope.mutation.invalidate or [])
    assert envelope.mutation.patches is not None
    assert len(envelope.mutation.patches["rooms"]) == 1


def test_redirects():
    redir = flux_redirect("/dashboard")
    assert redir.redirect == "/dashboard"

    ext = flux_external_redirect("https://example.com/login")
    assert ext.external_redirect == "https://example.com/login"
    assert ext.to_envelope().mutation.externalRedirect == "https://example.com/login"

    with pytest.raises(ValueError, match="origin-relative"):
        flux_redirect("https://example.com")
    with pytest.raises(ValueError, match="HTTP"):
        flux_external_redirect("javascript:alert(1)")


def test_public_patch_helpers_and_plural_aliases():
    result = mutation(
        patches={
            "items": [
                replace_resource([]),
                merge_object({"count": 1}),
                replace_item(1, {"id": 1}),
                remove_item(2),
                append_item({"id": 3}),
            ]
        },
        invalidates=["summary"],
    )
    payload = result.to_envelope().mutation
    assert payload.patches is not None
    assert [patch["op"] for patch in payload.patches["items"]] == [
        "replace-resource",
        "merge-object",
        "replace-item",
        "remove-item",
        "append-item",
    ]
    assert payload.invalidate == ["summary"]


def test_mutation_rejects_unknown_or_incomplete_patch_operations():
    with pytest.raises(ValueError, match="unsupported"):
        mutation(patches={"rooms": {"op": "execute-code"}})
    with pytest.raises(ValueError, match="requires an id"):
        mutation(patches={"rooms": {"op": "remove-item"}})


def test_mutation_response_omits_unset_optional_wire_fields():
    app = FastAPI()
    flux = FluxFast(app)

    @flux.mutation("/rooms")
    async def add_room():
        return mutation(patch={"rooms": append_item({"id": 2})})

    response = TestClient(app).post(
        "/rooms",
        headers={"X-FluxFast": "1"},
    )

    assert response.status_code == 200
    assert response.json()["mutation"] == {
        "patches": {
            "rooms": [{"op": "append-item", "value": {"id": 2}}],
        }
    }


def test_scoped_mutation_invalidations_publish_with_origin_metadata():
    app = FastAPI()
    cache = RecordingCache()
    broker = RecordingBroker()
    flux = FluxFast(app, cache=cache, broker=broker)
    tenant_scope = scope.tenant("hotel-1")
    user_scope = scope.user("alice")
    request_scope = scope.request()

    @flux.mutation("/rooms/checkout")
    async def checkout_room():
        return mutation(
            invalidates=[
                invalidate_resource("summary", scope=tenant_scope),
                "local-only",
                invalidate_resource("volatile", scope=request_scope),
                invalidate_resource("notifications", scope=user_scope),
            ]
        )

    response = TestClient(app).post(
        "/rooms/checkout",
        headers={
            HEADER_FLUXFAST: "1",
            HEADER_CLIENT_ID: "ff_current_tab",
        },
    )

    assert response.status_code == 200
    assert response.json()["mutation"]["invalidate"] == [
        "summary",
        "local-only",
        "volatile",
        "notifications",
    ]
    assert cache.deleted == [
        f"{tenant_scope.fingerprint()}::summary",
        f"{request_scope.fingerprint()}::volatile",
        f"{user_scope.fingerprint()}::notifications",
    ]
    assert broker.published == [
        (
            derive_live_topic(tenant_scope, "summary"),
            LiveInvalidateEvent(
                keys=["summary"],
                originClientId="ff_current_tab",
            ),
        ),
        (
            derive_live_topic(user_scope, "notifications"),
            LiveInvalidateEvent(
                keys=["notifications"],
                originClientId="ff_current_tab",
            ),
        ),
    ]


def test_invalid_mutation_client_identity_is_rejected_before_handler():
    app = FastAPI()
    cache = RecordingCache()
    broker = RecordingBroker()
    flux = FluxFast(app, cache=cache, broker=broker)
    calls = 0

    @flux.mutation("/rooms")
    async def update_rooms():
        nonlocal calls
        calls += 1
        return mutation(
            invalidates=[
                invalidate_resource("rooms", scope=scope.public()),
            ]
        )

    response = TestClient(app).post(
        "/rooms",
        headers={
            HEADER_FLUXFAST: "1",
            HEADER_CLIENT_ID: "contains space",
        },
    )

    assert response.status_code == 409
    assert response.json()["error"]["type"] == "ProtocolError"
    assert calls == 0
    assert cache.deleted == []
    assert broker.published == []
