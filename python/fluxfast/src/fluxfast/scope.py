"""Cache scoping model and fingerprint generation."""

import uuid
from dataclasses import dataclass
from enum import Enum
from urllib.parse import quote

from .errors import ScopeError


def _component(value: str | int, label: str) -> str:
    text = str(value)
    if not text:
        raise ScopeError(f"{label} must not be empty")
    return quote(text, safe="")


class ScopeType(str, Enum):
    PUBLIC = "public"
    USER = "user"
    TENANT = "tenant"
    REQUEST = "request"
    CUSTOM = "custom"


@dataclass(frozen=True, slots=True)
class CacheScope:
    scope_type: ScopeType
    identifier: str | None = None
    namespace: str | None = None
    _request_id: str | None = None

    def fingerprint(self) -> str:
        """Generate an internal cache key prefix guaranteeing isolation."""
        if self.scope_type == ScopeType.PUBLIC:
            return "public"
        elif self.scope_type == ScopeType.USER:
            return f"user:{_component(self.identifier or '', 'user identifier')}"
        elif self.scope_type == ScopeType.TENANT:
            return f"tenant:{_component(self.identifier or '', 'tenant identifier')}"
        elif self.scope_type == ScopeType.CUSTOM:
            namespace = _component(self.namespace or "", "custom namespace")
            identifier = _component(self.identifier or "", "custom identifier")
            return f"custom:{namespace}:{identifier}"
        elif self.scope_type == ScopeType.REQUEST:
            return f"request:{self._request_id or 'volatile'}"
        return "unscoped"

    @property
    def is_cacheable(self) -> bool:
        """Request-scoped data must not be cached across requests."""
        return self.scope_type != ScopeType.REQUEST


class _ScopeFactory:
    """Builder for cache scopes."""

    def public(self) -> CacheScope:
        return CacheScope(ScopeType.PUBLIC)

    def user(self, user_id: str | int) -> CacheScope:
        _component(user_id, "user identifier")
        return CacheScope(ScopeType.USER, identifier=str(user_id))

    def tenant(self, tenant_id: str | int) -> CacheScope:
        _component(tenant_id, "tenant identifier")
        return CacheScope(ScopeType.TENANT, identifier=str(tenant_id))

    def request(self) -> CacheScope:
        return CacheScope(ScopeType.REQUEST, _request_id=uuid.uuid4().hex)

    def custom(self, namespace: str, identifier: str | int) -> CacheScope:
        _component(namespace, "custom namespace")
        _component(identifier, "custom identifier")
        return CacheScope(ScopeType.CUSTOM, identifier=str(identifier), namespace=namespace)


scope = _ScopeFactory()
