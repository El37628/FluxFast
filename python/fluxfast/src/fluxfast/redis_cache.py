"""Optional Redis-backed resource cache for shared worker coherence."""

from __future__ import annotations

import importlib
import math
import time
from types import TracebackType
from typing import Any, Final, Protocol, Self

from ._redis_cache_codec import RedisResourceCodec
from ._redis_cache_keys import RedisCacheKeyspace
from .cache import CachedResource

DEFAULT_REDIS_MAX_VALUE_BYTES: Final = 1024 * 1024


class _RedisPipeline(Protocol):
    async def __aenter__(self) -> Self: ...

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc_value: BaseException | None,
        traceback: TracebackType | None,
    ) -> None: ...

    def get(self, key: str) -> Self: ...

    def pttl(self, key: str) -> Self: ...

    async def execute(self) -> list[Any]: ...


class _RedisClient(Protocol):
    def pipeline(self, *, transaction: bool) -> _RedisPipeline: ...

    async def set(self, key: str, value: bytes, *, px: int) -> Any: ...

    async def delete(self, *keys: str) -> Any: ...

    async def aclose(self) -> None: ...


def _load_redis_client(url: str, **kwargs: Any) -> _RedisClient:
    try:
        redis_asyncio = importlib.import_module("redis.asyncio")
    except ModuleNotFoundError as error:
        raise RuntimeError(
            "RedisResourceCache requires the optional Redis dependency. "
            'Install it with: pip install "fluxfast[redis]"'
        ) from error
    return redis_asyncio.Redis.from_url(url, **kwargs)


class RedisResourceCache:
    """Store bounded resource entries in one isolated Redis namespace."""

    def __init__(
        self,
        client: _RedisClient,
        *,
        namespace: str,
        max_value_bytes: int = DEFAULT_REDIS_MAX_VALUE_BYTES,
        owns_client: bool = False,
    ) -> None:
        self._client = client
        self._keyspace = RedisCacheKeyspace(namespace)
        self._codec = RedisResourceCodec(max_value_bytes=max_value_bytes)
        self._owns_client = owns_client
        self._closed = False

    @classmethod
    def from_url(
        cls,
        url: str,
        *,
        namespace: str,
        max_value_bytes: int = DEFAULT_REDIS_MAX_VALUE_BYTES,
        **redis_options: Any,
    ) -> RedisResourceCache:
        """Create a cache that owns its lazily imported async Redis client."""

        if not isinstance(url, str) or not url:
            raise ValueError("Redis URL must be a non-empty string")
        client = _load_redis_client(url, **redis_options)
        return cls(
            client,
            namespace=namespace,
            max_value_bytes=max_value_bytes,
            owns_client=True,
        )

    @property
    def namespace(self) -> str:
        """Return the explicit application namespace."""

        return self._keyspace.namespace

    @property
    def max_value_bytes(self) -> int:
        """Return the maximum encoded size accepted for one resource."""

        return self._codec.max_value_bytes

    async def get(self, key: str) -> CachedResource | None:
        """Read a live Redis entry and reconstruct its monotonic expiry."""

        self._ensure_open()
        redis_key = self._keyspace.resource_key(key)
        async with self._client.pipeline(transaction=True) as pipeline:
            pipeline.get(redis_key)
            pipeline.pttl(redis_key)
            result = await pipeline.execute()
        if len(result) != 2:
            raise RuntimeError("Redis cache read returned an unexpected result")
        payload, ttl_ms = result
        if payload is None:
            return None
        if isinstance(ttl_ms, bool) or not isinstance(ttl_ms, int):
            raise TypeError("Redis cache TTL returned an unexpected result")
        if ttl_ms <= 0:
            return None

        decoded = self._codec.decode(payload)
        return CachedResource(
            version=decoded.version,
            value=decoded.value,
            expires_at=time.monotonic() + ttl_ms / 1000,
            tags=decoded.tags,
        )

    async def set(
        self,
        key: str,
        resource: CachedResource,
        ttl: float,
    ) -> None:
        """Store a complete entry with Redis-native millisecond expiry."""

        self._ensure_open()
        redis_key = self._keyspace.resource_key(key)
        ttl_ms = _normalize_ttl_ms(ttl)
        if ttl_ms is None:
            await self._client.delete(redis_key)
            return
        payload = self._codec.encode(resource)
        await self._client.set(redis_key, payload, px=ttl_ms)

    async def delete(self, key: str) -> None:
        """Delete one resource key.

        Tag-index cleanup is added with the distributed deletion operation.
        """

        self._ensure_open()
        await self._client.delete(self._keyspace.resource_key(key))

    async def invalidate_tag(self, tag: str) -> None:
        """Invalidate a tag once Redis tag indexes are enabled."""

        raise NotImplementedError("Redis cache tag indexes are not enabled yet")

    async def clear(self) -> None:
        """Clear this namespace once bounded scanning is enabled."""

        raise NotImplementedError("Redis cache namespace clearing is not enabled yet")

    async def close(self) -> None:
        """Close the owned Redis client idempotently."""

        if self._closed:
            return
        self._closed = True
        if self._owns_client:
            await self._client.aclose()

    def _ensure_open(self) -> None:
        if self._closed:
            raise RuntimeError("Redis resource cache is closed")


def _normalize_ttl_ms(ttl: object) -> int | None:
    if (
        isinstance(ttl, bool)
        or not isinstance(ttl, (int, float))
        or not math.isfinite(ttl)
    ):
        raise ValueError("ttl must be a finite number")
    if ttl <= 0:
        return None
    return max(1, math.ceil(ttl * 1000))
