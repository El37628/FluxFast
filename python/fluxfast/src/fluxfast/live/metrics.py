"""Thread-safe internal counters for Live Resource observability."""

from __future__ import annotations

from dataclasses import asdict, dataclass
from threading import Lock
from typing import Literal

LivePublishedEventType = Literal["invalidate", "patch"]


@dataclass(frozen=True, slots=True)
class LiveMetricsSnapshot:
    """Immutable point-in-time values for every v0.4 live counter."""

    live_connections_active: int = 0
    live_connections_total: int = 0
    live_events_published: int = 0
    live_invalidations_published: int = 0
    live_patches_published: int = 0
    live_resyncs: int = 0
    live_queue_overflows: int = 0
    live_publish_errors: int = 0

    def as_dict(self) -> dict[str, int]:
        """Return a plain mapping suitable for an application's metrics exporter."""

        return asdict(self)


class LiveMetrics:
    """Collect optional process-local Live Resource counters.

    FluxFast does not prescribe a metrics backend. Applications can periodically
    export :meth:`snapshot` to Prometheus, OpenTelemetry, or another system.
    """

    _COUNTERS = tuple(LiveMetricsSnapshot.__dataclass_fields__)

    def __init__(self) -> None:
        self._lock = Lock()
        self._values = dict.fromkeys(self._COUNTERS, 0)

    def snapshot(self) -> LiveMetricsSnapshot:
        """Read all counters atomically."""

        with self._lock:
            return LiveMetricsSnapshot(**self._values)

    def connection_opened(self) -> None:
        with self._lock:
            self._values["live_connections_active"] += 1
            self._values["live_connections_total"] += 1

    def connection_closed(self) -> None:
        with self._lock:
            self._values["live_connections_active"] = max(
                0,
                self._values["live_connections_active"] - 1,
            )

    def event_published(self, event_type: LivePublishedEventType) -> None:
        with self._lock:
            self._values["live_events_published"] += 1
            if event_type == "invalidate":
                self._values["live_invalidations_published"] += 1
            elif event_type == "patch":
                self._values["live_patches_published"] += 1

    def resync(self) -> None:
        self._increment("live_resyncs")

    def queue_overflow(self) -> None:
        self._increment("live_queue_overflows")

    def publish_error(self) -> None:
        self._increment("live_publish_errors")

    def _increment(self, name: str) -> None:
        with self._lock:
            self._values[name] += 1
