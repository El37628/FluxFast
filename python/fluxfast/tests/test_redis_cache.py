"""Unit coverage for the optional Redis resource cache backend."""

from __future__ import annotations

import json
import logging
import time
from types import TracebackType
from typing import Any, Self

import pytest

import fluxfast.redis_cache as redis_cache_module
from fluxfast import (
    RedisCacheMetrics,
    RedisCacheMetricsSnapshot,
    RedisResourceCache,
    ResourceCacheError,
    ResourceCacheSerializationError,
    ResourceCacheUnavailableError,
)
from fluxfast._redis_cache_codec import RedisCachePayloadTooLargeError
from fluxfast.cache import CachedResource


class RecordingPipeline:
    def __init__(self, client: RecordingRedisClient) -> None:
        self.client = client
        self.commands: list[tuple[str, str]] = []

    async def __aenter__(self) -> Self:
        return self

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc_value: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        return None

    def get(self, key: str) -> Self:
        self.commands.append(("get", key))
        return self

    def pttl(self, key: str) -> Self:
        self.commands.append(("pttl", key))
        return self

    async def execute(self) -> list[Any]:
        self.client.pipeline_commands.append(self.commands)
        return list(self.client.pipeline_result)


class RecordingRedisClient:
    def __init__(self) -> None:
        self.pipeline_result: list[Any] = [None, -2]
        self.pipeline_transactions: list[bool] = []
        self.pipeline_commands: list[list[tuple[str, str]]] = []
        self.sets: list[tuple[str, bytes, int]] = []
        self.deletes: list[tuple[str, ...]] = []
        self.evals: list[tuple[str, int, tuple[str | bytes | int, ...]]] = []
        self.scan_results: list[tuple[int, list[str | bytes]]] = [(0, [])]
        self.scans: list[tuple[int, str, int]] = []
        self.unlinks: list[tuple[str | bytes, ...]] = []
        self.closed = False
        self.ping_result = True

    def pipeline(self, *, transaction: bool) -> RecordingPipeline:
        self.pipeline_transactions.append(transaction)
        return RecordingPipeline(self)

    async def set(self, key: str, value: bytes, *, px: int) -> bool:
        self.sets.append((key, value, px))
        return True

    async def delete(self, *keys: str) -> int:
        self.deletes.append(keys)
        return len(keys)

    async def eval(
        self,
        script: str,
        numkeys: int,
        *keys_and_args: str | bytes | int,
    ) -> int:
        self.evals.append((script, numkeys, keys_and_args))
        return 1

    async def scan(
        self,
        cursor: int,
        *,
        match: str,
        count: int,
    ) -> tuple[int, list[str | bytes]]:
        self.scans.append((cursor, match, count))
        return self.scan_results.pop(0)

    async def unlink(self, *keys: str | bytes) -> int:
        self.unlinks.append(keys)
        return len(keys)

    async def ping(self) -> bool:
        return self.ping_result

    async def aclose(self) -> None:
        self.closed = True


class FailingPipeline(RecordingPipeline):
    async def execute(self) -> list[Any]:
        raise ConnectionError("redis://user:secret@example.invalid unavailable")


class FailingRedisClient(RecordingRedisClient):
    def __init__(self, operation: str) -> None:
        super().__init__()
        self.operation = operation

    def pipeline(self, *, transaction: bool) -> RecordingPipeline:
        if self.operation == "get":
            return FailingPipeline(self)
        return super().pipeline(transaction=transaction)

    async def eval(
        self,
        script: str,
        numkeys: int,
        *keys_and_args: str | bytes | int,
    ) -> int:
        if self.operation == "eval":
            raise ConnectionError("redis://user:secret@example.invalid unavailable")
        return await super().eval(script, numkeys, *keys_and_args)

    async def scan(
        self,
        cursor: int,
        *,
        match: str,
        count: int,
    ) -> tuple[int, list[str | bytes]]:
        if self.operation == "scan":
            raise ConnectionError("redis://user:secret@example.invalid unavailable")
        return await super().scan(cursor, match=match, count=count)

    async def aclose(self) -> None:
        if self.operation == "close":
            raise ConnectionError("redis://user:secret@example.invalid unavailable")
        await super().aclose()


def make_resource() -> CachedResource:
    return CachedResource(
        version="v1",
        value={"rooms": [101, 102]},
        expires_at=time.monotonic() + 60,
        tags=("rooms",),
    )


def test_cache_metrics_start_at_zero_and_export_a_bounded_snapshot() -> None:
    metrics = RedisCacheMetrics()

    assert metrics.snapshot() == RedisCacheMetricsSnapshot()
    assert metrics.snapshot().as_dict() == {
        "cache_gets": 0,
        "cache_hits": 0,
        "cache_misses": 0,
        "cache_sets": 0,
        "cache_deletes": 0,
        "cache_tag_invalidations": 0,
        "cache_clears": 0,
        "cache_errors": 0,
        "cache_payload_bytes_written": 0,
        "cache_payload_bytes_read": 0,
    }


@pytest.mark.anyio
async def test_cache_metrics_track_successful_operations_and_payload_bytes() -> None:
    client = RecordingRedisClient()
    metrics = RedisCacheMetrics()
    cache = RedisResourceCache(
        client,
        namespace="hotel-prod",
        metrics=metrics,
    )

    assert await cache.get("missing") is None
    await cache.set("rooms", make_resource(), ttl=60)
    payload = client.evals[0][2][3]
    assert isinstance(payload, bytes)
    client.pipeline_result = [payload, 60_000]
    assert await cache.get("rooms") is not None
    await cache.delete("rooms")
    await cache.invalidate_tag("rooms")
    await cache.clear()

    assert metrics.snapshot() == RedisCacheMetricsSnapshot(
        cache_gets=2,
        cache_hits=1,
        cache_misses=1,
        cache_sets=1,
        cache_deletes=1,
        cache_tag_invalidations=1,
        cache_clears=1,
        cache_payload_bytes_written=len(payload),
        cache_payload_bytes_read=len(payload),
    )


@pytest.mark.anyio
async def test_cache_metrics_count_failures_without_turning_them_into_misses() -> None:
    metrics = RedisCacheMetrics()
    cache = RedisResourceCache(
        FailingRedisClient("get"),
        namespace="hotel-prod",
        metrics=metrics,
    )

    with pytest.raises(ResourceCacheUnavailableError):
        await cache.get("tenant:secret::rooms")

    assert metrics.snapshot() == RedisCacheMetricsSnapshot(
        cache_gets=1,
        cache_errors=1,
    )


@pytest.mark.anyio
async def test_cache_set_uses_opaque_key_safe_json_and_native_ttl() -> None:
    client = RecordingRedisClient()
    cache = RedisResourceCache(client, namespace="hotel-prod")

    await cache.set("tenant:secret::rooms", make_resource(), ttl=1.2341)

    assert len(client.evals) == 1
    script, numkeys, keys_and_args = client.evals[0]
    assert "ZADD" in script
    assert numkeys == 3
    redis_key, membership_key, tag_key, payload, ttl_ms, tag_prefix = keys_and_args
    assert isinstance(redis_key, str)
    assert isinstance(membership_key, str)
    assert isinstance(tag_key, str)
    assert isinstance(payload, bytes)
    assert redis_key.startswith("fluxfast:cache:v1:hotel-prod:resource:")
    assert membership_key.startswith(
        "fluxfast:cache:v1:hotel-prod:resource-tags:"
    )
    assert tag_key.startswith("fluxfast:cache:v1:hotel-prod:tag:")
    assert tag_prefix == "fluxfast:cache:v1:hotel-prod:tag:"
    assert "tenant:secret" not in redis_key
    assert ttl_ms == 1235
    assert json.loads(payload) == {
        "schema": 1,
        "version": "v1",
        "value": {"rooms": [101, 102]},
        "tags": ["rooms"],
    }


@pytest.mark.anyio
async def test_cache_get_reads_value_and_ttl_in_one_transaction() -> None:
    client = RecordingRedisClient()
    client.pipeline_result = [
        b'{"schema":1,"version":"v1","value":{"rooms":[101]},"tags":["rooms"]}',
        4250,
    ]
    cache = RedisResourceCache(client, namespace="hotel-prod")
    before = time.monotonic()

    resource = await cache.get("tenant:secret::rooms")

    after = time.monotonic()
    assert resource is not None
    assert resource.version == "v1"
    assert resource.value == {"rooms": [101]}
    assert resource.tags == ("rooms",)
    assert before + 4.25 <= resource.expires_at <= after + 4.25
    assert client.pipeline_transactions == [True]
    assert [name for name, _key in client.pipeline_commands[0]] == ["get", "pttl"]
    assert client.pipeline_commands[0][0][1] == client.pipeline_commands[0][1][1]


@pytest.mark.anyio
@pytest.mark.parametrize(
    "result",
    [
        [None, -2],
        [b'{"schema":1,"version":"v1","value":1,"tags":[]}', 0],
        [b'{"schema":1,"version":"v1","value":1,"tags":[]}', -1],
    ],
)
async def test_cache_get_treats_missing_or_non_live_values_as_misses(result) -> None:
    client = RecordingRedisClient()
    client.pipeline_result = result
    cache = RedisResourceCache(client, namespace="hotel-prod")

    assert await cache.get("rooms") is None


@pytest.mark.anyio
@pytest.mark.parametrize(
    "payload",
    [
        b"not-json-super-secret",
        b'{"schema":99,"version":"v1","value":1,"tags":[]}',
        b'{"schema":1,"version":"","value":1,"tags":[]}',
    ],
)
async def test_corrupt_entries_are_safely_removed_and_become_misses(
    payload: bytes,
    caplog: pytest.LogCaptureFixture,
) -> None:
    client = RecordingRedisClient()
    client.pipeline_result = [payload, 60_000]
    cache = RedisResourceCache(client, namespace="hotel-prod")
    caplog.set_level(logging.WARNING, logger="fluxfast.cache.redis")

    assert await cache.get("tenant:secret::rooms") is None

    assert len(client.evals) == 1
    assert "Removed an invalid Redis resource cache entry" in caplog.text
    assert "not-json-super-secret" not in caplog.text
    assert "tenant:secret" not in caplog.text
    assert "hotel-prod" not in caplog.text
    assert cache.metrics.snapshot() == RedisCacheMetricsSnapshot(
        cache_gets=1,
        cache_misses=1,
        cache_deletes=1,
        cache_errors=1,
        cache_payload_bytes_read=len(payload),
    )


@pytest.mark.anyio
async def test_corrupt_entry_cleanup_failure_is_strict() -> None:
    client = FailingRedisClient("eval")
    client.pipeline_result = [b"not-json", 60_000]
    cache = RedisResourceCache(client, namespace="hotel-prod")

    with pytest.raises(ResourceCacheUnavailableError) as captured:
        await cache.get("rooms")

    assert captured.value.details == {"operation": "delete"}
    assert isinstance(captured.value.__cause__, ConnectionError)


@pytest.mark.anyio
@pytest.mark.parametrize("ttl", [0, -1, -0.5])
async def test_non_positive_ttl_deletes_instead_of_storing(ttl) -> None:
    client = RecordingRedisClient()
    cache = RedisResourceCache(client, namespace="hotel-prod")

    await cache.set("rooms", make_resource(), ttl=ttl)

    assert len(client.evals) == 1
    _script, numkeys, keys_and_args = client.evals[0]
    assert numkeys == 2
    assert len(keys_and_args) == 3
    assert client.sets == []


@pytest.mark.anyio
async def test_delete_removes_only_the_opaque_resource_key() -> None:
    client = RecordingRedisClient()
    cache = RedisResourceCache(client, namespace="hotel-prod")

    await cache.delete("tenant:secret::rooms")

    assert len(client.evals) == 1
    script, numkeys, keys_and_args = client.evals[0]
    assert "ZREM" in script
    assert numkeys == 2
    redis_key, membership_key, tag_prefix = keys_and_args
    assert isinstance(redis_key, str)
    assert isinstance(membership_key, str)
    assert redis_key.startswith("fluxfast:cache:v1:hotel-prod:resource:")
    assert membership_key.startswith(
        "fluxfast:cache:v1:hotel-prod:resource-tags:"
    )
    assert tag_prefix == "fluxfast:cache:v1:hotel-prod:tag:"
    assert "tenant:secret" not in redis_key


@pytest.mark.anyio
async def test_invalidate_tag_uses_only_opaque_namespace_prefixes() -> None:
    client = RecordingRedisClient()
    cache = RedisResourceCache(client, namespace="hotel-prod")

    await cache.invalidate_tag("tenant:secret")

    assert len(client.evals) == 1
    script, numkeys, keys_and_args = client.evals[0]
    assert "ZREMRANGEBYSCORE" in script
    assert numkeys == 1
    tag_key, resource_prefix, membership_prefix, tag_prefix = keys_and_args
    assert isinstance(tag_key, str)
    assert "tenant:secret" not in tag_key
    assert resource_prefix == "fluxfast:cache:v1:hotel-prod:resource:"
    assert membership_prefix == "fluxfast:cache:v1:hotel-prod:resource-tags:"
    assert tag_prefix == "fluxfast:cache:v1:hotel-prod:tag:"


@pytest.mark.anyio
async def test_invalid_tag_is_a_caller_error_not_an_availability_error() -> None:
    cache = RedisResourceCache(RecordingRedisClient(), namespace="hotel-prod")

    with pytest.raises(ValueError, match="non-empty string"):
        await cache.invalidate_tag("")


@pytest.mark.anyio
async def test_clear_scans_exact_namespace_and_unlinks_in_bounded_batches() -> None:
    client = RecordingRedisClient()
    client.scan_results = [
        (7, [b"key-1", b"key-2", b"key-3"]),
        (0, [b"key-4"]),
    ]
    cache = RedisResourceCache(
        client,
        namespace="hotel:blue",
        scan_count=2,
    )

    await cache.clear()

    assert client.scans == [
        (0, "fluxfast:cache:v1:hotel%3Ablue:*", 2),
        (7, "fluxfast:cache:v1:hotel%3Ablue:*", 2),
    ]
    assert client.unlinks == [
        (b"key-1", b"key-2"),
        (b"key-3",),
        (b"key-4",),
    ]
    assert client.deletes == []


@pytest.mark.anyio
@pytest.mark.parametrize("ttl", [True, float("nan"), float("inf"), "60"])
async def test_cache_rejects_invalid_ttls(ttl) -> None:
    cache = RedisResourceCache(RecordingRedisClient(), namespace="hotel-prod")

    with pytest.raises(ValueError, match="finite number"):
        await cache.set("rooms", make_resource(), ttl=ttl)


@pytest.mark.anyio
async def test_oversized_set_raises_public_serialization_error_without_writing() -> None:
    client = RecordingRedisClient()
    cache = RedisResourceCache(
        client,
        namespace="hotel-prod",
        max_value_bytes=64,
    )
    resource = make_resource()
    resource.value = "x" * 256

    with pytest.raises(ResourceCacheSerializationError) as captured:
        await cache.set("rooms", resource, ttl=60)

    assert captured.value.details == {"operation": "set"}
    assert isinstance(captured.value.__cause__, RedisCachePayloadTooLargeError)
    assert client.evals == []
    assert cache.metrics.snapshot() == RedisCacheMetricsSnapshot(cache_errors=1)


@pytest.mark.anyio
async def test_oversized_stored_entry_is_removed_as_a_recovered_miss(
    caplog: pytest.LogCaptureFixture,
) -> None:
    payload = b"super-secret-value" * 8
    client = RecordingRedisClient()
    client.pipeline_result = [payload, 60_000]
    cache = RedisResourceCache(
        client,
        namespace="hotel-prod",
        max_value_bytes=64,
    )
    caplog.set_level(logging.WARNING, logger="fluxfast.cache.redis")

    assert await cache.get("tenant:secret::rooms") is None

    assert len(client.evals) == 1
    assert "Removed an invalid Redis resource cache entry" in caplog.text
    assert "super-secret-value" not in caplog.text
    assert "tenant:secret" not in caplog.text
    assert cache.metrics.snapshot() == RedisCacheMetricsSnapshot(
        cache_gets=1,
        cache_misses=1,
        cache_deletes=1,
        cache_errors=1,
        cache_payload_bytes_read=len(payload),
    )


@pytest.mark.anyio
async def test_get_failure_raises_public_unavailable_error_without_fallback(
    caplog: pytest.LogCaptureFixture,
) -> None:
    cache = RedisResourceCache(FailingRedisClient("get"), namespace="hotel-prod")
    caplog.set_level(logging.ERROR, logger="fluxfast.cache.redis")

    with pytest.raises(ResourceCacheUnavailableError) as captured:
        await cache.get("tenant:secret::rooms")

    assert captured.value.details == {"operation": "get"}
    assert isinstance(captured.value.__cause__, ConnectionError)
    assert "Redis resource cache operation failed" in caplog.text
    assert "user:secret" not in caplog.text
    assert "tenant:secret" not in caplog.text
    assert "hotel-prod" not in caplog.text


@pytest.mark.anyio
@pytest.mark.parametrize(
    ("method_name", "args", "operation"),
    [
        ("set", ("rooms", make_resource(), 60), "set"),
        ("delete", ("rooms",), "delete"),
        ("invalidate_tag", ("rooms",), "invalidate_tag"),
    ],
)
async def test_eval_failures_use_stable_public_errors(
    method_name: str,
    args: tuple[Any, ...],
    operation: str,
) -> None:
    cache = RedisResourceCache(FailingRedisClient("eval"), namespace="hotel-prod")

    with pytest.raises(ResourceCacheUnavailableError) as captured:
        await getattr(cache, method_name)(*args)

    assert captured.value.details == {"operation": operation}
    assert isinstance(captured.value.__cause__, ConnectionError)
    assert cache.metrics.snapshot().cache_errors == 1


@pytest.mark.anyio
async def test_clear_and_close_failures_use_stable_public_errors() -> None:
    clear_cache = RedisResourceCache(
        FailingRedisClient("scan"),
        namespace="hotel-prod",
    )
    close_cache = RedisResourceCache(
        FailingRedisClient("close"),
        namespace="hotel-prod",
        owns_client=True,
    )

    with pytest.raises(ResourceCacheUnavailableError) as clear_error:
        await clear_cache.clear()
    with pytest.raises(ResourceCacheUnavailableError) as close_error:
        await close_cache.close()

    assert clear_error.value.details == {"operation": "clear"}
    assert close_error.value.details == {"operation": "close"}
    assert clear_cache.metrics.snapshot().cache_errors == 1
    assert close_cache.metrics.snapshot().cache_errors == 1


@pytest.mark.anyio
async def test_invalid_backend_responses_raise_cache_errors() -> None:
    get_client = RecordingRedisClient()
    get_client.pipeline_result = [b"value"]
    clear_client = RecordingRedisClient()
    clear_client.scan_results = [(True, [])]

    get_cache = RedisResourceCache(get_client, namespace="hotel-prod")
    clear_cache = RedisResourceCache(clear_client, namespace="hotel-prod")

    with pytest.raises(ResourceCacheError, match="invalid response"):
        await get_cache.get("rooms")
    with pytest.raises(ResourceCacheError, match="invalid response"):
        await clear_cache.clear()

    assert get_cache.metrics.snapshot().cache_errors == 1
    assert clear_cache.metrics.snapshot().cache_errors == 1


@pytest.mark.anyio
async def test_injected_client_is_not_owned_by_default() -> None:
    client = RecordingRedisClient()
    cache = RedisResourceCache(client, namespace="hotel-prod")

    await cache.close()
    await cache.close()

    assert client.closed is False
    with pytest.raises(ResourceCacheError, match="closed"):
        await cache.get("rooms")


@pytest.mark.anyio
async def test_owned_client_closes_idempotently() -> None:
    client = RecordingRedisClient()
    cache = RedisResourceCache(
        client,
        namespace="hotel-prod",
        owns_client=True,
    )

    await cache.close()
    await cache.close()

    assert client.closed is True


def test_from_url_creates_owned_client_and_forwards_options(monkeypatch) -> None:
    client = RecordingRedisClient()
    metrics = RedisCacheMetrics()
    calls = []

    def load(url: str, **options: Any) -> RecordingRedisClient:
        calls.append((url, options))
        return client

    monkeypatch.setattr(redis_cache_module, "_load_redis_client", load)

    cache = RedisResourceCache.from_url(
        "redis://localhost:6379/3",
        namespace="hotel-prod",
        metrics=metrics,
        decode_responses=False,
    )

    assert cache.namespace == "hotel-prod"
    assert calls == [
        ("redis://localhost:6379/3", {"decode_responses": False})
    ]
    assert cache._owns_client is True
    assert cache.metrics is metrics


def test_from_url_explains_how_to_install_optional_dependency(monkeypatch) -> None:
    def missing_redis(_name: str) -> Any:
        raise ModuleNotFoundError("No module named 'redis'")

    monkeypatch.setattr(redis_cache_module.importlib, "import_module", missing_redis)

    with pytest.raises(RuntimeError, match=r'pip install "fluxfast\[redis\]"'):
        RedisResourceCache.from_url(
            "redis://localhost:6379/0",
            namespace="hotel-prod",
        )


@pytest.mark.parametrize("url", [None, "", 1])
def test_from_url_rejects_invalid_urls(url) -> None:
    with pytest.raises(ValueError, match="Redis URL"):
        RedisResourceCache.from_url(url, namespace="hotel-prod")


def test_cache_configuration_is_exposed_and_validated() -> None:
    cache = RedisResourceCache(
        RecordingRedisClient(),
        namespace="hotel-prod",
        max_value_bytes=2048,
        scan_count=25,
    )

    assert cache.namespace == "hotel-prod"
    assert cache.max_value_bytes == 2048
    assert cache.scan_count == 25


@pytest.mark.anyio
async def test_redis_cache_healthcheck_tracks_connectivity_and_close() -> None:
    client = RecordingRedisClient()
    cache = RedisResourceCache(client, namespace="hotel-prod")

    assert await cache.healthcheck() is True
    client.ping_result = False
    assert await cache.healthcheck() is False
    await cache.close()
    assert await cache.healthcheck() is False


@pytest.mark.parametrize("scan_count", [True, False, 0, -1, 1.5, "100"])
def test_cache_rejects_invalid_scan_counts(scan_count) -> None:
    with pytest.raises(ValueError, match="scan_count must be a positive integer"):
        RedisResourceCache(
            RecordingRedisClient(),
            namespace="hotel-prod",
            scan_count=scan_count,
        )
