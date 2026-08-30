"""Scoped coordination for Live Resource subscriptions and publications."""

from __future__ import annotations

import hashlib
from collections.abc import AsyncIterator, Sequence
from dataclasses import dataclass
from typing import Any, Final

from ..cache import ResourceCacheBackend
from ..errors import FluxFastLiveScopeError
from ..page import Page
from ..scope import CacheScope, ScopeType
from .broker import LiveBroker
from .events import (
    MAX_LIVE_EVENT_KEYS,
    MAX_LIVE_RESOURCE_KEY_LENGTH,
    LiveEvent,
    LiveInvalidateEvent,
    LivePatchEvent,
)

_TOPIC_PERSONALIZATION: Final = b"fluxfast-live-v1"
_TOPIC_PREFIX: Final = "fluxfast.live."
_REUSABLE_SCOPE_TYPES: Final = frozenset(
    {ScopeType.PUBLIC, ScopeType.USER, ScopeType.TENANT, ScopeType.CUSTOM}
)


def _validate_resource_key(key: str) -> None:
    if (
        not isinstance(key, str)
        or not key.strip()
        or len(key) > MAX_LIVE_RESOURCE_KEY_LENGTH
        or "," in key
        or any(ord(char) < 32 for char in key)
    ):
        raise ValueError("live resource keys must be safe non-empty strings")


def _validate_scope(scope: CacheScope) -> None:
    if not isinstance(scope, CacheScope) or scope.scope_type not in _REUSABLE_SCOPE_TYPES:
        raise FluxFastLiveScopeError(
            "Live publishing requires an explicit reusable scope. "
            "Use scope.public(), scope.user(), scope.tenant(), or scope.custom()."
        )


def derive_live_topic(scope: CacheScope, resource_key: str) -> str:
    """Derive an opaque deterministic broker topic for a scoped resource."""

    _validate_scope(scope)
    _validate_resource_key(resource_key)
    identity = f"{scope.fingerprint()}::{resource_key}".encode()
    digest = hashlib.blake2b(
        identity,
        digest_size=32,
        person=_TOPIC_PERSONALIZATION,
    ).hexdigest()
    return f"{_TOPIC_PREFIX}{digest}"


@dataclass(frozen=True, slots=True)
class LiveSubscription:
    """Authorized logical keys and their opaque internal broker topics."""

    keys: tuple[str, ...]
    topics: frozenset[str]


class LiveCoordinator:
    """Coordinates scoped subscriptions, cache invalidation, and publication."""

    def __init__(self, cache: ResourceCacheBackend, broker: LiveBroker) -> None:
        self.cache = cache
        self.broker = broker

    def resolve_subscription(
        self,
        page: Page,
        requested_keys: set[str],
    ) -> LiveSubscription:
        """Map browser-visible keys through authoritative page declarations."""

        if not isinstance(requested_keys, set):
            raise TypeError("requested live keys must be a set")
        if len(requested_keys) > MAX_LIVE_EVENT_KEYS:
            raise ValueError(
                f"a live subscription may request at most {MAX_LIVE_EVENT_KEYS} keys"
            )
        for key in requested_keys:
            _validate_resource_key(key)

        authorized = {
            spec.key: derive_live_topic(spec.scope, spec.key)
            for spec in page.resources
            if spec.live and spec.key in requested_keys
        }
        return LiveSubscription(
            keys=tuple(sorted(authorized)),
            topics=frozenset(authorized.values()),
        )

    def subscribe(self, subscription: LiveSubscription) -> AsyncIterator[LiveEvent]:
        """Open a broker subscription previously authorized against a page."""

        if not subscription.keys or not subscription.topics:
            raise ValueError("no requested live resources are declared by this page")
        return self.broker.subscribe(set(subscription.topics))

    async def invalidate(
        self,
        resource_key: str,
        *,
        scope: CacheScope,
        origin_client_id: str | None = None,
    ) -> None:
        """Delete cached state, then publish a scoped invalidation event."""

        topic = derive_live_topic(scope, resource_key)
        event = LiveInvalidateEvent(
            keys=[resource_key],
            originClientId=origin_client_id,
        )
        await self.cache.delete(self._cache_key(scope, resource_key))
        await self.broker.publish(topic, event)

    async def patch(
        self,
        resource_key: str,
        patches: Sequence[dict[str, Any]],
        *,
        scope: CacheScope,
        origin_client_id: str | None = None,
    ) -> None:
        """Delete cached state, then publish validated optimistic patches."""

        topic = derive_live_topic(scope, resource_key)
        event = LivePatchEvent(
            patches={resource_key: list(patches)},
            originClientId=origin_client_id,
        )
        await self.cache.delete(self._cache_key(scope, resource_key))
        await self.broker.publish(topic, event)

    async def close(self) -> None:
        """Close the configured broker and all its subscriptions."""

        await self.broker.close()

    @staticmethod
    def _cache_key(scope: CacheScope, resource_key: str) -> str:
        return f"{scope.fingerprint()}::{resource_key}"
