"""Server-Timing and instrumentation metrics."""

import time
from dataclasses import dataclass, field


@dataclass
class TimingMetrics:
    """Collects timing and execution statistics for a FluxFast request."""

    page_dur_ms: float = 0.0
    resources_dur_ms: float = 0.0
    serialize_dur_ms: float = 0.0
    cache_hits: int = 0
    cache_misses: int = 0
    resources_sent: int = 0
    resources_omitted: int = 0
    _start_time: float = field(default_factory=time.perf_counter)

    def to_server_timing_header(self) -> str:
        """Format metrics as a standard Server-Timing header."""
        parts = [
            f"fluxfast-page;dur={self.page_dur_ms:.2f}",
            f"fluxfast-resources;dur={self.resources_dur_ms:.2f}",
            f"fluxfast-serialize;dur={self.serialize_dur_ms:.2f}",
        ]
        return ", ".join(parts)

