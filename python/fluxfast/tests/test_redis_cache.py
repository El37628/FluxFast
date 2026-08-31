"""Unit coverage for the optional Redis resource cache backend."""

from __future__ import annotations

import json
import time
from types import TracebackType
from typing import Any, Self

import pytest

import fluxfast.redis_cache as redis_cache_module
from fluxfast import RedisResourceCache
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
        self.closed = False

    def pipeline(self, *, transaction: bool) -> RecordingPipeline:
        self.pipeline_transactions.append(transaction)
        return RecordingPipeline(self)

    async def set(self, key: str, value: bytes, *, px: int) -> bool:
        self.sets.append((key, value, px))
        return True

    async def delete(self, *keys: str) -> int:
        self.deletes.append(keys)
        return len(keys)

    async def aclose(self) -> None:
        self.closed = True


def make_resource() -> CachedResource:
    return CachedResource(
        version="v1",
        value={"rooms": [101, 102]},
        expires_at=time.monotonic() + 60,
        tags=("rooms",),
    )


@pytest.mark.anyio
async def test_cache_set_uses_opaque_key_safe_json_and_native_ttl() -> None:
    client = RecordingRedisClient()
    cache = RedisResourceCache(client, namespace="hotel-prod")

    await cache.set("tenant:secret::rooms", make_resource(), ttl=1.2341)

    assert len(client.sets) == 1
    redis_key, payload, ttl_ms = client.sets[0]
    assert redis_key.startswith("fluxfast:cache:v1:hotel-prod:resource:")
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
@pytest.mark.parametrize("ttl", [0, -1, -0.5])
async def test_non_positive_ttl_deletes_instead_of_storing(ttl) -> None:
    client = RecordingRedisClient()
    cache = RedisResourceCache(client, namespace="hotel-prod")

    await cache.set("rooms", make_resource(), ttl=ttl)

    assert len(client.deletes) == 1
    assert client.sets == []


@pytest.mark.anyio
@pytest.mark.parametrize("ttl", [True, float("nan"), float("inf"), "60"])
async def test_cache_rejects_invalid_ttls(ttl) -> None:
    cache = RedisResourceCache(RecordingRedisClient(), namespace="hotel-prod")

    with pytest.raises(ValueError, match="finite number"):
        await cache.set("rooms", make_resource(), ttl=ttl)


@pytest.mark.anyio
async def test_injected_client_is_not_owned_by_default() -> None:
    client = RecordingRedisClient()
    cache = RedisResourceCache(client, namespace="hotel-prod")

    await cache.close()
    await cache.close()

    assert client.closed is False
    with pytest.raises(RuntimeError, match="closed"):
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
    calls = []

    def load(url: str, **options: Any) -> RecordingRedisClient:
        calls.append((url, options))
        return client

    monkeypatch.setattr(redis_cache_module, "_load_redis_client", load)

    cache = RedisResourceCache.from_url(
        "redis://localhost:6379/3",
        namespace="hotel-prod",
        decode_responses=False,
    )

    assert cache.namespace == "hotel-prod"
    assert calls == [
        ("redis://localhost:6379/3", {"decode_responses": False})
    ]
    assert cache._owns_client is True


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
    )

    assert cache.namespace == "hotel-prod"
    assert cache.max_value_bytes == 2048
