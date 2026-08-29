"""Server-side in-memory resource caching backend and interface."""

import time
from collections import OrderedDict
from dataclasses import dataclass, replace
from typing import Any, Protocol

import anyio


@dataclass(slots=True)
class CachedResource:
    """Represents a cached resource entry."""

    version: str
    value: Any
    expires_at: float
    tags: tuple[str, ...] = ()

    @property
    def is_expired(self) -> bool:
        return time.monotonic() >= self.expires_at


class ResourceCacheBackend(Protocol):
    """Abstract interface for server resource caches."""

    async def get(self, key: str) -> CachedResource | None: ...

    async def set(
        self,
        key: str,
        resource: CachedResource,
        ttl: float,
    ) -> None: ...

    async def delete(self, key: str) -> None: ...

    async def invalidate_tag(self, tag: str) -> None: ...

    async def clear(self) -> None: ...


class MemoryResourceCache:
    """Async-safe, bounded, TTL-aware LRU in-memory resource cache."""

    def __init__(self, max_entries: int = 10000):
        if max_entries <= 0:
            raise ValueError("max_entries must be greater than zero")
        self.max_entries = max_entries
        self._cache: OrderedDict[str, CachedResource] = OrderedDict()
        self._tag_index: dict[str, set[str]] = {}
        self._lock = anyio.Lock()

    async def get(self, key: str) -> CachedResource | None:
        async with self._lock:
            entry = self._cache.get(key)
            if entry is None:
                return None

            # Check expiration
            if entry.is_expired:
                self._remove_internal(key)
                return None

            # Mark as recently used (LRU)
            self._cache.move_to_end(key)
            return entry

    async def set(self, key: str, resource: CachedResource, ttl: float) -> None:
        async with self._lock:
            if key in self._cache:
                self._remove_internal(key)

            if ttl <= 0:
                return

            # Evict LRU if full
            while len(self._cache) >= self.max_entries:
                oldest_key, oldest_entry = self._cache.popitem(last=False)
                self._cleanup_tags(oldest_key, oldest_entry.tags)

            stored_resource = replace(
                resource,
                expires_at=time.monotonic() + ttl,
            )
            self._cache[key] = stored_resource

            # Index tags
            for tag in stored_resource.tags:
                if tag not in self._tag_index:
                    self._tag_index[tag] = set()
                self._tag_index[tag].add(key)

    async def delete(self, key: str) -> None:
        async with self._lock:
            self._remove_internal(key)

    async def invalidate_tag(self, tag: str) -> None:
        async with self._lock:
            keys = self._tag_index.pop(tag, set())
            for key in keys:
                if key in self._cache:
                    self._remove_internal(key)

    async def clear(self) -> None:
        async with self._lock:
            self._cache.clear()
            self._tag_index.clear()

    def _remove_internal(self, key: str) -> None:
        entry = self._cache.pop(key, None)
        if entry:
            self._cleanup_tags(key, entry.tags)

    def _cleanup_tags(self, key: str, tags: tuple[str, ...] | None = None) -> None:
        if tags is None:
            # Clean from all tag index sets
            for tag_keys in self._tag_index.values():
                tag_keys.discard(key)
        else:
            for tag in tags:
                if tag in self._tag_index:
                    self._tag_index[tag].discard(key)
                    if not self._tag_index[tag]:
                        del self._tag_index[tag]
