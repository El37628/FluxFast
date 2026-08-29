"""Tests for ResourceSpec and resource definition builder."""

from dataclasses import asdict

import pytest

from fluxfast import Page, resource, scope
from fluxfast.scope import ScopeType


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


def test_page_rejects_duplicate_resource_keys():
    with pytest.raises(ValueError, match="unique"):
        Page(
            component="duplicate/index",
            resources=[
                resource("same", lambda: 1),
                resource("same", lambda: 2),
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
