"""Bounded process-local counters for Redis resource-cache operations."""

from __future__ import annotations

from dataclasses import asdict, dataclass
from threading import Lock


@dataclass(frozen=True, slots=True)
class RedisCacheMetricsSnapshot:
    """Immutable point-in-time values for Redis cache operations."""

    cache_gets: int = 0
    cache_hits: int = 0
    cache_misses: int = 0
    cache_sets: int = 0
    cache_deletes: int = 0
    cache_tag_invalidations: int = 0
    cache_clears: int = 0
    cache_errors: int = 0
    cache_payload_bytes_written: int = 0
    cache_payload_bytes_read: int = 0

    def as_dict(self) -> dict[str, int]:
        """Return a plain mapping suitable for an application's exporter."""

        return asdict(self)


class RedisCacheMetrics:
    """Collect low-cardinality, process-local Redis cache counters.

    FluxFast does not prescribe a metrics backend. Applications can periodically
    export :meth:`snapshot` to Prometheus, OpenTelemetry, or another system.
    Counters deliberately contain no resource, scope, namespace, or Redis URL
    dimensions.
    """

    _COUNTERS = tuple(RedisCacheMetricsSnapshot.__dataclass_fields__)

    def __init__(self) -> None:
        self._lock = Lock()
        self._values = dict.fromkeys(self._COUNTERS, 0)

    def snapshot(self) -> RedisCacheMetricsSnapshot:
        """Read all counters atomically."""

        with self._lock:
            return RedisCacheMetricsSnapshot(**self._values)

    def get_started(self) -> None:
        self._increment("cache_gets")

    def get_hit(self) -> None:
        self._increment("cache_hits")

    def get_miss(self) -> None:
        self._increment("cache_misses")

    def set_completed(self, payload_bytes: int) -> None:
        self._increment_with_bytes(
            "cache_sets",
            "cache_payload_bytes_written",
            payload_bytes,
        )

    def delete_completed(self) -> None:
        self._increment("cache_deletes")

    def tag_invalidation_completed(self) -> None:
        self._increment("cache_tag_invalidations")

    def clear_completed(self) -> None:
        self._increment("cache_clears")

    def error(self) -> None:
        self._increment("cache_errors")

    def payload_read(self, payload_bytes: int) -> None:
        self._add_bytes("cache_payload_bytes_read", payload_bytes)

    def _increment(self, name: str) -> None:
        with self._lock:
            self._values[name] += 1

    def _increment_with_bytes(
        self,
        operation_name: str,
        bytes_name: str,
        payload_bytes: int,
    ) -> None:
        _validate_payload_bytes(payload_bytes)
        with self._lock:
            self._values[operation_name] += 1
            self._values[bytes_name] += payload_bytes

    def _add_bytes(self, name: str, payload_bytes: int) -> None:
        _validate_payload_bytes(payload_bytes)
        with self._lock:
            self._values[name] += payload_bytes


def _validate_payload_bytes(payload_bytes: object) -> None:
    if (
        isinstance(payload_bytes, bool)
        or not isinstance(payload_bytes, int)
        or payload_bytes < 0
    ):
        raise ValueError("payload_bytes must be a non-negative integer")
