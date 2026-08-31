"""Tests for ResourceSpec and resource definition builder."""

from dataclasses import asdict

import pytest
from fastapi import FastAPI
from pydantic import BaseModel

from fluxfast import (
    FluxFast,
    FluxFastLiveScopeError,
    MemoryResourceCache,
    Page,
    resource,
    scope,
)
from fluxfast.engine import ResourceEngine
from fluxfast.scope import ScopeType
from fluxfast.timing import TimingMetrics


class Room(BaseModel):
    id: int


def test_resource_spec_creation():
    spec = resource(
        "hotel",
        lambda: {"name": "Grand Hotel"},
        scope=scope.tenant(123),
        ttl=60,
        tags=["hotel", "hotel:123"],
    )

    assert spec.key == "hotel"
    assert spec.ttl == 60
    assert spec.scope.scope_type == ScopeType.TENANT
    assert spec.scope.fingerprint() == "tenant:123"
    assert spec.tags == ("hotel", "hotel:123")
    assert spec.contract is None


def test_typed_resource_spec_retains_contract_and_string_runtime_key():
    flux = FluxFast(FastAPI())
    rooms = flux.define_resource("rooms", list[Room])

    spec = resource(
        rooms,
        lambda: [Room(id=1)],
        scope=scope.tenant("hotel-1"),
        ttl=60,
        tags=["rooms"],
        defer=True,
        live=True,
    )

    assert spec.key == "rooms"
    assert isinstance(spec.key, str)
    assert spec.contract is rooms
    assert spec.scope == scope.tenant("hotel-1")
    assert spec.ttl == 60
    assert spec.tags == ("rooms",)
    assert spec.defer is True
    assert spec.live is True


def test_typed_resource_uses_contract_key_in_live_scope_errors():
    flux = FluxFast(FastAPI())
    activity = flux.define_resource("activity", list[Room])

    with pytest.raises(
        FluxFastLiveScopeError,
        match='Live resource "activity" requires an explicit reusable scope',
    ):
        resource(activity, list, live=True)


@pytest.mark.anyio
async def test_typed_resource_flows_through_existing_resource_engine():
    flux = FluxFast(FastAPI())
    rooms = flux.define_resource("rooms", list[Room])
    page = Page(
        component="rooms/index",
        resources=[resource(rooms, lambda: [Room(id=1)])],
    )

    resolution = await ResourceEngine.resolve_page_resources(
        page=page,
        known_versions={},
        only_keys=None,
        cache=MemoryResourceCache(),
        metrics=TimingMetrics(),
    )

    assert resolution.resources["rooms"].value == [{"id": 1}]


def test_resource_default_scope():
    spec_with_ttl = resource("private_by_default", lambda: 1, ttl=30)
    assert spec_with_ttl.scope.scope_type == ScopeType.REQUEST

    spec_zero_ttl = resource("request_data", lambda: 2, ttl=0)
    assert spec_zero_ttl.scope.scope_type == ScopeType.REQUEST


def test_resource_defer_flag_defaults_false_and_is_retained():
    blocking = resource("summary", lambda: 1)
    deferred = resource("analytics", lambda: 2, defer=True)

    assert blocking.defer is False
    assert deferred.defer is True
    assert asdict(deferred)["defer"] is True


def test_resource_live_flag_defaults_false_and_is_retained():
    ordinary = resource("summary", lambda: 1)
    live = resource("notifications", lambda: 2, scope=scope.user(123), live=True)

    assert ordinary.live is False
    assert live.live is True
    assert asdict(live)["live"] is True


@pytest.mark.parametrize(
    "reusable_scope",
    [
        scope.public(),
        scope.user("user-1"),
        scope.tenant("tenant-1"),
        scope.custom("organization", "org-1"),
    ],
)
def test_live_resource_accepts_every_reusable_scope(reusable_scope):
    spec = resource("activity", list, scope=reusable_scope, live=True)

    assert spec.live is True
    assert spec.scope == reusable_scope


@pytest.mark.parametrize("resource_scope", [None, scope.request()])
def test_live_resource_requires_explicit_reusable_scope(resource_scope):
    with pytest.raises(
        FluxFastLiveScopeError,
        match=(
            'Live resource "activity" requires an explicit reusable scope\\. '
            r"Use scope\.public\(\), scope\.user\(\), scope\.tenant\(\), or "
            r"scope\.custom\(\)\."
        ),
    ):
        resource("activity", list, scope=resource_scope, live=True)


@pytest.mark.parametrize(
    ("defer", "live"),
    [(False, False), (True, False), (False, True), (True, True)],
)
def test_resource_supports_every_defer_live_combination(defer, live):
    declared_scope = scope.public() if live else None
    spec = resource(
        "activity",
        list,
        scope=declared_scope,
        defer=defer,
        live=live,
    )

    assert spec.defer is defer
    assert spec.live is live


def test_resource_validates_public_inputs():
    with pytest.raises(ValueError, match="resource key"):
        resource("", lambda: 1)
    with pytest.raises(ValueError, match="commas"):
        resource("rooms,summary", lambda: 1)
    with pytest.raises(ValueError, match="ttl"):
        resource("bad", lambda: 1, ttl=-1)
    with pytest.raises(TypeError, match="loader"):
        resource("bad", 1)  # type: ignore[arg-type]
    with pytest.raises(TypeError, match="defer"):
        resource("bad", lambda: 1, defer=1)  # type: ignore[arg-type]
    with pytest.raises(TypeError, match="live"):
        resource("bad", lambda: 1, live=1)  # type: ignore[arg-type]


def test_page_rejects_duplicate_resource_keys():
    with pytest.raises(ValueError, match="unique"):
        Page(
            component="duplicate/index",
            resources=[
                resource("same", lambda: 1),
                resource("same", lambda: 2),
            ],
        )


def test_page_rejects_duplicate_typed_and_string_resource_keys():
    flux = FluxFast(FastAPI())
    rooms = flux.define_resource("rooms", list[Room])

    with pytest.raises(ValueError, match="duplicates: rooms"):
        Page(
            component="duplicate/index",
            resources=[
                resource(rooms, list),
                resource("rooms", list),
            ],
        )


def test_page_creation():
    p = Page(
        component="dashboard/index",
        resources=[
            resource("auth", lambda: {"name": "Admin"}),
            resource("stats", lambda: {"visits": 100}),
        ],
        meta={"title": "Dashboard"},
    )
    assert p.component == "dashboard/index"
    assert len(p.resources) == 2
    assert p.meta["title"] == "Dashboard"
