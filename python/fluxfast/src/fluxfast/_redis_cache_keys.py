"""Namespace validation and opaque key derivation for Redis resource caches."""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass, field
from typing import Final
from urllib.parse import quote

REDIS_CACHE_KEY_PREFIX: Final = "fluxfast:cache:v1"
MAX_REDIS_CACHE_NAMESPACE_LENGTH: Final = 128
_NAMESPACE_PATTERN: Final = re.compile(r"[A-Za-z0-9_.:-]+", re.ASCII)
_DIGEST_SIZE: Final = 32


@dataclass(frozen=True, slots=True)
class RedisCacheKeyspace:
    """Derive bounded, namespace-isolated keys without exposing identities."""

    namespace: str
    prefix: str = field(init=False)

    def __post_init__(self) -> None:
        _validate_namespace(self.namespace)
        # A namespace may contain ``:`` for human-friendly hierarchy. Encoding
        # it prevents ``a`` from sharing a scan prefix with ``a:b``.
        encoded_namespace = quote(self.namespace, safe="-_.")
        object.__setattr__(
            self,
            "prefix",
            f"{REDIS_CACHE_KEY_PREFIX}:{encoded_namespace}",
        )

    @property
    def scan_pattern(self) -> str:
        """Return the glob restricted to this exact namespace."""

        return f"{self.prefix}:*"

    @property
    def resource_prefix(self) -> str:
        """Return the namespace-local prefix for opaque resource keys."""

        return f"{self.prefix}:resource:"

    @property
    def resource_tags_prefix(self) -> str:
        """Return the namespace-local prefix for tag-membership keys."""

        return f"{self.prefix}:resource-tags:"

    @property
    def tag_prefix(self) -> str:
        """Return the namespace-local prefix for opaque tag indexes."""

        return f"{self.prefix}:tag:"

    def resource_key(self, logical_identity: str) -> str:
        """Return an opaque key for one complete logical resource identity."""

        return f"{self.resource_prefix}{_digest(logical_identity, 'identity')}"

    def resource_tags_key(self, logical_identity: str) -> str:
        """Return the private tag-membership key for one resource identity."""

        return f"{self.resource_tags_prefix}{_digest(logical_identity, 'identity')}"

    def tag_key(self, tag: str) -> str:
        """Return an opaque key for one namespace-local cache tag."""

        return f"{self.tag_prefix}{_digest(tag, 'tag')}"


def _validate_namespace(namespace: object) -> None:
    if (
        not isinstance(namespace, str)
        or not namespace
        or len(namespace) > MAX_REDIS_CACHE_NAMESPACE_LENGTH
        or _NAMESPACE_PATTERN.fullmatch(namespace) is None
    ):
        raise ValueError(
            "namespace must contain 1 to "
            f"{MAX_REDIS_CACHE_NAMESPACE_LENGTH} ASCII letters, digits, "
            + "periods, underscores, colons, or hyphens"
        )


def _digest(value: object, name: str) -> str:
    if not isinstance(value, str) or not value:
        raise ValueError(f"{name} must be a non-empty string")
    try:
        encoded = value.encode("utf-8")
    except UnicodeEncodeError as error:
        raise ValueError(f"{name} must be valid UTF-8") from error
    return hashlib.blake2b(encoded, digest_size=_DIGEST_SIZE).hexdigest()
