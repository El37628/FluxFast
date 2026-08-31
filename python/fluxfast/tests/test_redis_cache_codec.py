"""Tests for bounded schema-versioned Redis resource JSON."""

import json
import time

import pytest

from fluxfast._redis_cache_codec import (
    REDIS_CACHE_SCHEMA,
    RedisCacheCodecError,
    RedisCacheDecodeError,
    RedisCachePayloadTooLargeError,
    RedisResourceCodec,
)
from fluxfast.cache import CachedResource


def make_resource(**overrides):
    values = {
        "version": "a" * 32,
        "value": {"message": "Kuala Lumpur", "available": True},
        "expires_at": time.monotonic() + 60,
        "tags": ("rooms", "availability"),
    }
    values.update(overrides)
    return CachedResource(**values)


def test_codec_round_trips_json_resource_without_process_expiry():
    codec = RedisResourceCodec(max_value_bytes=4096)

    encoded = codec.encode(make_resource())
    decoded = codec.decode(encoded)

    assert decoded.version == "a" * 32
    assert decoded.value == {"message": "Kuala Lumpur", "available": True}
    assert decoded.tags == ("rooms", "availability")
    payload = json.loads(encoded)
    assert payload["schema"] == REDIS_CACHE_SCHEMA
    assert "expires_at" not in payload
    assert b'": ' not in encoded
    assert b', "' not in encoded


def test_codec_uses_jsonable_conversion_and_utf8():
    codec = RedisResourceCodec(max_value_bytes=4096)

    encoded = codec.encode(
        make_resource(value={"coordinates": (3.139, 101.6869), "name": "房间"})
    )

    assert "房间".encode() in encoded
    assert codec.decode(encoded).value == {
        "coordinates": [3.139, 101.6869],
        "name": "房间",
    }


@pytest.mark.parametrize("max_value_bytes", [True, False, 0, -1, 1.5, "1024"])
def test_codec_rejects_invalid_payload_bounds(max_value_bytes):
    with pytest.raises(ValueError, match="positive integer"):
        RedisResourceCodec(max_value_bytes=max_value_bytes)


def test_codec_rejects_oversized_values_before_storage():
    codec = RedisResourceCodec(max_value_bytes=64)

    with pytest.raises(RedisCachePayloadTooLargeError, match="64 bytes"):
        codec.encode(make_resource(value="x" * 128, tags=()))


def test_codec_rejects_oversized_values_before_decoding():
    codec = RedisResourceCodec(max_value_bytes=8)

    with pytest.raises(RedisCachePayloadTooLargeError, match="8 bytes"):
        codec.decode(b"{" + b" " * 8 + b"}")


@pytest.mark.parametrize(
    "payload, message",
    [
        (b"\xff", "valid UTF-8"),
        (b"not-json", "valid JSON"),
        (b"NaN", "valid JSON"),
        (b"[]", "JSON object"),
    ],
)
def test_codec_rejects_malformed_serialization(payload, message):
    codec = RedisResourceCodec(max_value_bytes=4096)

    with pytest.raises(RedisCacheDecodeError, match=message):
        codec.decode(payload)


@pytest.mark.parametrize(
    "changes, message",
    [
        ({"schema": 2}, "unknown schema"),
        ({"schema": True}, "unknown schema"),
        ({"version": ""}, "version"),
        ({"version": "x" * 129}, "version"),
        ({"version": 1}, "version"),
        ({"tags": "rooms"}, "tags"),
        ({"tags": [""]}, "tags"),
        ({"tags": [1]}, "tags"),
    ],
)
def test_codec_rejects_invalid_cache_fields(changes, message):
    codec = RedisResourceCodec(max_value_bytes=4096)
    payload = {
        "schema": REDIS_CACHE_SCHEMA,
        "version": "v1",
        "value": {"count": 1},
        "tags": ["rooms"],
    }
    payload.update(changes)

    with pytest.raises(RedisCacheDecodeError, match=message):
        codec.decode(json.dumps(payload))


@pytest.mark.parametrize(
    "payload",
    [
        {"schema": 1, "version": "v1", "value": 1},
        {
            "schema": 1,
            "version": "v1",
            "value": 1,
            "tags": [],
            "future": True,
        },
    ],
)
def test_codec_rejects_missing_or_unknown_schema_fields(payload):
    codec = RedisResourceCodec(max_value_bytes=4096)

    with pytest.raises(RedisCacheDecodeError, match="fields"):
        codec.decode(json.dumps(payload))


@pytest.mark.parametrize(
    "changes, message",
    [
        ({"version": ""}, "version"),
        ({"tags": ("rooms", "")}, "tags"),
        ({"value": object()}, "safe JSON"),
    ],
)
def test_codec_rejects_invalid_resource_fields(changes, message):
    codec = RedisResourceCodec(max_value_bytes=4096)

    with pytest.raises(RedisCacheCodecError, match=message):
        codec.encode(make_resource(**changes))


def test_codec_requires_cached_resource_and_bytes_or_text():
    codec = RedisResourceCodec(max_value_bytes=4096)

    with pytest.raises(TypeError, match="CachedResource"):
        codec.encode({"version": "v1"})
    with pytest.raises(TypeError, match="bytes or text"):
        codec.decode(memoryview(b"{}"))
