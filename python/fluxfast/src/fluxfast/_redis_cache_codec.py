"""Safe internal JSON codec for Redis resource cache entries."""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Final

from .cache import CachedResource
from .serialization import to_jsonable

REDIS_CACHE_SCHEMA: Final = 1
_PAYLOAD_FIELDS: Final = frozenset({"schema", "version", "value", "tags"})
_MAX_VERSION_LENGTH: Final = 128


class RedisCacheCodecError(ValueError):
    """Base error for invalid Redis cache serialization."""


class RedisCacheDecodeError(RedisCacheCodecError):
    """Raised when a Redis cache payload is malformed or unsupported."""


class RedisCachePayloadTooLargeError(RedisCacheCodecError):
    """Raised when an encoded Redis cache entry exceeds its configured bound."""


@dataclass(frozen=True, slots=True)
class DecodedRedisResource:
    """Process-independent fields recovered from a Redis cache entry."""

    version: str
    value: Any
    tags: tuple[str, ...]


class RedisResourceCodec:
    """Encode and validate bounded schema-versioned resource cache JSON."""

    def __init__(self, *, max_value_bytes: int) -> None:
        if (
            isinstance(max_value_bytes, bool)
            or not isinstance(max_value_bytes, int)
            or max_value_bytes < 1
        ):
            raise ValueError("max_value_bytes must be a positive integer")
        self.max_value_bytes = max_value_bytes

    def encode(self, resource: CachedResource) -> bytes:
        """Return one compact UTF-8 cache entry without process-local expiry."""

        if not isinstance(resource, CachedResource):
            raise TypeError("resource must be a CachedResource")
        self._validate_version(resource.version, RedisCacheCodecError)
        self._validate_tags(resource.tags, RedisCacheCodecError)
        try:
            payload = {
                "schema": REDIS_CACHE_SCHEMA,
                "version": resource.version,
                "value": to_jsonable(resource.value),
                "tags": list(resource.tags),
            }
            encoded = json.dumps(
                payload,
                ensure_ascii=False,
                separators=(",", ":"),
                allow_nan=False,
            ).encode("utf-8")
        except (RecursionError, TypeError, ValueError, OverflowError) as error:
            raise RedisCacheCodecError(
                "resource value cannot be encoded as safe JSON"
            ) from error
        self._check_size(len(encoded))
        return encoded

    def decode(self, payload: bytes | str) -> DecodedRedisResource:
        """Validate one cache payload and return its process-independent data."""

        if isinstance(payload, bytes):
            self._check_size(len(payload))
            try:
                text = payload.decode("utf-8")
            except UnicodeDecodeError as error:
                raise RedisCacheDecodeError(
                    "Redis cache entry is not valid UTF-8"
                ) from error
        elif isinstance(payload, str):
            try:
                encoded_size = len(payload.encode("utf-8"))
            except UnicodeEncodeError as error:
                raise RedisCacheDecodeError(
                    "Redis cache entry is not valid UTF-8"
                ) from error
            self._check_size(encoded_size)
            text = payload
        else:
            raise TypeError("Redis cache entry must be bytes or text")

        try:
            decoded = json.loads(text, parse_constant=_reject_json_constant)
        except (json.JSONDecodeError, RecursionError, ValueError) as error:
            raise RedisCacheDecodeError(
                "Redis cache entry is not valid JSON"
            ) from error
        if not isinstance(decoded, dict):
            raise RedisCacheDecodeError("Redis cache entry must be a JSON object")
        if set(decoded) != _PAYLOAD_FIELDS:
            raise RedisCacheDecodeError(
                "Redis cache entry has missing or unsupported fields"
            )
        if decoded["schema"] != REDIS_CACHE_SCHEMA or isinstance(
            decoded["schema"], bool
        ):
            raise RedisCacheDecodeError("Redis cache entry has an unknown schema")

        version = decoded["version"]
        tags = decoded["tags"]
        self._validate_version(version, RedisCacheDecodeError)
        self._validate_tags(tags, RedisCacheDecodeError)
        return DecodedRedisResource(
            version=version,
            value=decoded["value"],
            tags=tuple(tags),
        )

    def _check_size(self, size: int) -> None:
        if size > self.max_value_bytes:
            raise RedisCachePayloadTooLargeError(
                f"Redis cache entry exceeds {self.max_value_bytes} bytes"
            )

    @staticmethod
    def _validate_version(
        version: object,
        error_type: type[RedisCacheCodecError],
    ) -> None:
        if (
            not isinstance(version, str)
            or not version.strip()
            or len(version) > _MAX_VERSION_LENGTH
        ):
            raise error_type(
                "Redis cache entry version must be a non-empty string "
                f"of at most {_MAX_VERSION_LENGTH} characters"
            )

    @staticmethod
    def _validate_tags(
        tags: object,
        error_type: type[RedisCacheCodecError],
    ) -> None:
        if not isinstance(tags, (list, tuple)) or any(
            not isinstance(tag, str) or not tag for tag in tags
        ):
            raise error_type(
                "Redis cache entry tags must be a list of non-empty strings"
            )


def _reject_json_constant(value: str) -> None:
    raise ValueError(f"unsupported JSON constant: {value}")
