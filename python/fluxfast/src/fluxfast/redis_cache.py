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

_SET_WITH_TAGS_SCRIPT: Final = """
local resource_key = KEYS[1]
local membership_key = KEYS[2]
local ttl_ms = tonumber(ARGV[2])
local redis_time = redis.call('TIME')
local now_ms = tonumber(redis_time[1]) * 1000 + math.floor(tonumber(redis_time[2]) / 1000)
local expires_at_ms = now_ms + ttl_ms

local function refresh_tag(tag_key)
    redis.call('ZREMRANGEBYSCORE', tag_key, '-inf', now_ms)
    local last_member = redis.call('ZRANGE', tag_key, -1, -1, 'WITHSCORES')
    if #last_member == 0 then
        redis.call('DEL', tag_key)
    else
        redis.call('PEXPIREAT', tag_key, math.ceil(tonumber(last_member[2])))
    end
end

local old_tags = redis.call('SMEMBERS', membership_key)
for _, tag_key in ipairs(old_tags) do
    if string.sub(tag_key, 1, string.len(ARGV[3])) == ARGV[3] then
        redis.call('ZREM', tag_key, resource_key)
        refresh_tag(tag_key)
    end
end

redis.call('SET', resource_key, ARGV[1], 'PX', ttl_ms)
redis.call('DEL', membership_key)
for index = 3, #KEYS do
    local tag_key = KEYS[index]
    redis.call('ZREMRANGEBYSCORE', tag_key, '-inf', now_ms)
    redis.call('ZADD', tag_key, expires_at_ms, resource_key)
    redis.call('SADD', membership_key, tag_key)
    refresh_tag(tag_key)
end
if #KEYS > 2 then
    redis.call('PEXPIREAT', membership_key, expires_at_ms)
end
return expires_at_ms
"""

_DELETE_WITH_TAGS_SCRIPT: Final = """
local resource_key = KEYS[1]
local membership_key = KEYS[2]
local redis_time = redis.call('TIME')
local now_ms = tonumber(redis_time[1]) * 1000 + math.floor(tonumber(redis_time[2]) / 1000)

local old_tags = redis.call('SMEMBERS', membership_key)
for _, tag_key in ipairs(old_tags) do
    if string.sub(tag_key, 1, string.len(ARGV[1])) == ARGV[1] then
        redis.call('ZREM', tag_key, resource_key)
        redis.call('ZREMRANGEBYSCORE', tag_key, '-inf', now_ms)
        local last_member = redis.call('ZRANGE', tag_key, -1, -1, 'WITHSCORES')
        if #last_member == 0 then
            redis.call('DEL', tag_key)
        else
            redis.call('PEXPIREAT', tag_key, math.ceil(tonumber(last_member[2])))
        end
    end
end
return redis.call('DEL', resource_key, membership_key)
"""

_INVALIDATE_TAG_SCRIPT: Final = """
local target_tag_key = KEYS[1]
local resource_prefix = ARGV[1]
local membership_prefix = ARGV[2]
local tag_prefix = ARGV[3]
local redis_time = redis.call('TIME')
local now_ms = tonumber(redis_time[1]) * 1000 + math.floor(tonumber(redis_time[2]) / 1000)

redis.call('ZREMRANGEBYSCORE', target_tag_key, '-inf', now_ms)
local resource_keys = redis.call('ZRANGE', target_tag_key, 0, -1)
local removed = 0
for _, resource_key in ipairs(resource_keys) do
    if string.sub(resource_key, 1, string.len(resource_prefix)) == resource_prefix then
        local digest = string.sub(resource_key, string.len(resource_prefix) + 1)
        local membership_key = membership_prefix .. digest
        local resource_tags = redis.call('SMEMBERS', membership_key)
        for _, tag_key in ipairs(resource_tags) do
            if string.sub(tag_key, 1, string.len(tag_prefix)) == tag_prefix then
                redis.call('ZREM', tag_key, resource_key)
                redis.call('ZREMRANGEBYSCORE', tag_key, '-inf', now_ms)
                local last_member = redis.call('ZRANGE', tag_key, -1, -1, 'WITHSCORES')
                if #last_member == 0 then
                    redis.call('DEL', tag_key)
                else
                    redis.call('PEXPIREAT', tag_key, math.ceil(tonumber(last_member[2])))
                end
            end
        end
        removed = removed + redis.call('DEL', resource_key)
        redis.call('DEL', membership_key)
    end
end
redis.call('DEL', target_tag_key)
return removed
"""


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

    async def eval(
        self,
        script: str,
        numkeys: int,
        *keys_and_args: str | bytes | int,
    ) -> Any: ...

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
            await self._delete_resource(key)
            return
        payload = self._codec.encode(resource)
        membership_key = self._keyspace.resource_tags_key(key)
        tag_keys = tuple(
            dict.fromkeys(self._keyspace.tag_key(tag) for tag in resource.tags)
        )
        redis_keys = (redis_key, membership_key, *tag_keys)
        await self._client.eval(
            _SET_WITH_TAGS_SCRIPT,
            len(redis_keys),
            *redis_keys,
            payload,
            ttl_ms,
            self._keyspace.tag_prefix,
        )

    async def delete(self, key: str) -> None:
        """Delete one resource key.

        Tag-index cleanup is added with the distributed deletion operation.
        """

        self._ensure_open()
        await self._delete_resource(key)

    async def invalidate_tag(self, tag: str) -> None:
        """Atomically remove every live resource in one opaque tag index."""

        self._ensure_open()
        await self._client.eval(
            _INVALIDATE_TAG_SCRIPT,
            1,
            self._keyspace.tag_key(tag),
            self._keyspace.resource_prefix,
            self._keyspace.resource_tags_prefix,
            self._keyspace.tag_prefix,
        )

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

    async def _delete_resource(self, key: str) -> None:
        resource_key = self._keyspace.resource_key(key)
        membership_key = self._keyspace.resource_tags_key(key)
        await self._client.eval(
            _DELETE_WITH_TAGS_SCRIPT,
            2,
            resource_key,
            membership_key,
            self._keyspace.tag_prefix,
        )


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
