"""Resource specification and builder functions."""

import math
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass, field
from typing import Any

from .errors import FluxFastLiveScopeError
from .scope import CacheScope, ScopeType
from .scope import scope as scope_builder

ResourceLoader = Callable[[], Awaitable[Any]] | Callable[[], Any]


@dataclass(slots=True)
class ResourceSpec:
    """Specification of an independently resolvable, versioned resource."""

    key: str
    loader: ResourceLoader
    scope: CacheScope = field(default_factory=scope_builder.request)
    ttl: float = 0.0
    tags: tuple[str, ...] = ()
    defer: bool = False
    live: bool = False


def resource(
    key: str,
    loader: ResourceLoader,
    *,
    scope: CacheScope | None = None,
    ttl: float = 0.0,
    tags: Sequence[str] = (),
    defer: bool = False,
    live: bool = False,
) -> ResourceSpec:
    """Create a ResourceSpec for a page."""
    if not isinstance(key, str) or not key.strip() or len(key) > 128:
        raise ValueError("resource key must be a non-empty string of at most 128 characters")
    if "," in key or any(ord(char) < 32 for char in key):
        raise ValueError("resource key must not contain commas or control characters")
    if not callable(loader):
        raise TypeError("resource loader must be callable")
    if not isinstance(ttl, (int, float)) or not math.isfinite(ttl) or ttl < 0:
        raise ValueError("resource ttl must be a finite, non-negative number")
    if any(not isinstance(tag, str) or not tag for tag in tags):
        raise ValueError("resource tags must be non-empty strings")
    if not isinstance(defer, bool):
        raise TypeError("resource defer must be a boolean")
    if not isinstance(live, bool):
        raise TypeError("resource live must be a boolean")

    # Cache isolation must be intentional. A positive TTL without an explicit
    # scope remains request-scoped rather than silently becoming public data.
    resolved_scope = scope if scope is not None else scope_builder.request()
    if live and (scope is None or resolved_scope.scope_type == ScopeType.REQUEST):
        raise FluxFastLiveScopeError(
            f'Live resource "{key}" requires an explicit reusable scope. '
            "Use scope.public(), scope.user(), scope.tenant(), or scope.custom()."
        )

    return ResourceSpec(
        key=key,
        loader=loader,
        scope=resolved_scope,
        ttl=ttl,
        tags=tuple(tags),
        defer=defer,
        live=live,
    )
