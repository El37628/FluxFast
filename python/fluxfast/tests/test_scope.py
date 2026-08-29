"""Tests for cache scoping, fingerprints, and security isolation."""

import pytest

from fluxfast import MemoryResourceCache, Page, ScopeError, resource, scope
from fluxfast.engine import ResourceEngine
from fluxfast.scope import ScopeType
from fluxfast.timing import TimingMetrics


def test_scope_fingerprints():
    pub = scope.public()
    assert pub.scope_type == ScopeType.PUBLIC
    assert pub.fingerprint() == "public"
    assert pub.is_cacheable is True

    user1 = scope.user(42)
    assert user1.fingerprint() == "user:42"
    assert user1.is_cacheable is True

    user2 = scope.user("alice")
    assert user2.fingerprint() == "user:alice"

    tenant1 = scope.tenant("hotel_1")
    assert tenant1.fingerprint() == "tenant:hotel_1"
    assert tenant1.is_cacheable is True

    custom = scope.custom("org", "team_alpha")
    assert custom.fingerprint() == "custom:org:team_alpha"
    assert custom.is_cacheable is True

    req = scope.request()
    assert req.scope_type == ScopeType.REQUEST
    assert req.fingerprint().startswith("request:")
    assert req.is_cacheable is False


def test_scope_isolation():
    # User A and User B must never generate the same fingerprint
    scope_a = scope.user("user_a")
    scope_b = scope.user("user_b")
    assert scope_a.fingerprint() != scope_b.fingerprint()

    # Tenant A and Tenant B must never generate the same fingerprint
    tenant_a = scope.tenant("t1")
    tenant_b = scope.tenant("t2")
    assert tenant_a.fingerprint() != tenant_b.fingerprint()

    # User with ID "1" vs Tenant with ID "1" must differ
    assert scope.user("1").fingerprint() != scope.tenant("1").fingerprint()

    # Delimiter-like input is encoded and cannot alias another scope/key split.
    assert scope.user("a::rooms").fingerprint() != scope.user("a").fingerprint()
    assert scope.custom("a:b", "c").fingerprint() != scope.custom("a", "b:c").fingerprint()


def test_scope_rejects_empty_identifiers():
    with pytest.raises(ScopeError):
        scope.user("")
    with pytest.raises(ScopeError):
        scope.custom("", "id")


@pytest.mark.anyio
async def test_same_wire_key_never_reuses_another_users_cached_value():
    cache = MemoryResourceCache()
    user_a = Page(
        "account/index",
        [resource("auth", lambda: {"id": "a"}, scope=scope.user("a"), ttl=60)],
    )
    user_b = Page(
        "account/index",
        [resource("auth", lambda: {"id": "b"}, scope=scope.user("b"), ttl=60)],
    )

    result_a = await ResourceEngine.resolve_page_resources(
        user_a, {}, None, cache, TimingMetrics()
    )
    result_b = await ResourceEngine.resolve_page_resources(
        user_b,
        {"auth": result_a.resources["auth"].version},
        None,
        cache,
        TimingMetrics(),
    )

    assert result_b.resources["auth"].value == {"id": "b"}
    assert result_b.resources["auth"].version != result_a.resources["auth"].version
