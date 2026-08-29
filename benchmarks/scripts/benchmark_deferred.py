"""Compare blocking initial envelopes with progressive deferred settlement."""

import argparse
import statistics
import time
from dataclasses import dataclass

from fastapi.testclient import TestClient
from fluxfast.capabilities import CAPABILITY_DEFERRED_RESOURCES
from fluxfast.headers import HEADER_CAPABILITIES, HEADER_FLUXFAST, HEADER_ONLY

from benchmarks.fixtures.deferred import (
    RESOURCE_DELAYS_SECONDS,
    create_deferred_benchmark_app,
)


@dataclass(frozen=True)
class Measurement:
    duration_ms: float
    payload_bytes: int
    resource_count: int
    deferred_count: int
    cache_hits: int
    cache_misses: int


def measured_get(
    client: TestClient,
    path: str,
    headers: dict[str, str],
) -> tuple[dict[str, object], Measurement]:
    started = time.perf_counter()
    response = client.get(path, headers=headers)
    duration_ms = (time.perf_counter() - started) * 1_000
    response.raise_for_status()
    envelope = response.json()
    return envelope, Measurement(
        duration_ms=duration_ms,
        payload_bytes=len(response.content),
        resource_count=len(envelope["resources"]),
        deferred_count=len(envelope.get("deferred", [])),
        cache_hits=int(response.headers["X-FluxFast-Cache-Hits"]),
        cache_misses=int(response.headers["X-FluxFast-Cache-Misses"]),
    )


def median(values: list[Measurement], field: str) -> float:
    return statistics.median(getattr(value, field) for value in values)


def format_measurement(label: str, values: list[Measurement]) -> str:
    return (
        f"{label}: {median(values, 'duration_ms'):.2f} ms median, "
        f"{median(values, 'payload_bytes'):.0f} bytes median, "
        f"{median(values, 'resource_count'):.0f} resources, "
        f"{median(values, 'deferred_count'):.0f} pending, "
        f"{median(values, 'cache_hits'):.0f} cache hits, "
        f"{median(values, 'cache_misses'):.0f} cache misses"
    )


def run_benchmark(samples: int = 3) -> None:
    if samples <= 0:
        raise ValueError("samples must be positive")

    app, loader_counts = create_deferred_benchmark_app()
    client = TestClient(app)
    legacy_headers = {HEADER_FLUXFAST: "1"}
    capable_headers = {
        **legacy_headers,
        HEADER_CAPABILITIES: CAPABILITY_DEFERRED_RESOURCES,
    }

    blocking_baseline: list[Measurement] = []
    blocking_capable: list[Measurement] = []
    deferred_initial: list[Measurement] = []
    deferred_follow_up: list[Measurement] = []
    deferred_settlement_ms: list[float] = []

    for _ in range(samples):
        before = dict(loader_counts)

        baseline_envelope, baseline_measurement = measured_get(
            client,
            "/blocking",
            legacy_headers,
        )
        capable_envelope, capable_measurement = measured_get(
            client,
            "/blocking",
            capable_headers,
        )
        initial_envelope, initial_measurement = measured_get(
            client,
            "/deferred",
            capable_headers,
        )

        assert set(baseline_envelope["resources"]) == set(RESOURCE_DELAYS_SECONDS)
        assert set(capable_envelope["resources"]) == set(RESOURCE_DELAYS_SECONDS)
        assert set(initial_envelope["resources"]) == {"fast"}
        assert initial_envelope["deferred"] == ["medium", "slow"]
        assert loader_counts["deferred:fast"] == before["deferred:fast"] + 1
        assert loader_counts["deferred:medium"] == before["deferred:medium"]
        assert loader_counts["deferred:slow"] == before["deferred:slow"]

        follow_up_envelope, follow_up_measurement = measured_get(
            client,
            "/deferred",
            {**capable_headers, HEADER_ONLY: "medium,slow"},
        )
        assert set(follow_up_envelope["resources"]) == {"medium", "slow"}
        assert "deferred" not in follow_up_envelope
        assert loader_counts["deferred:medium"] == before["deferred:medium"] + 1
        assert loader_counts["deferred:slow"] == before["deferred:slow"] + 1
        for key in RESOURCE_DELAYS_SECONDS:
            assert loader_counts[f"blocking:{key}"] == before[f"blocking:{key}"] + 2

        blocking_baseline.append(baseline_measurement)
        blocking_capable.append(capable_measurement)
        deferred_initial.append(initial_measurement)
        deferred_follow_up.append(follow_up_measurement)
        deferred_settlement_ms.append(
            initial_measurement.duration_ms + follow_up_measurement.duration_ms
        )

    blocking_payload = median(blocking_baseline, "payload_bytes")
    deferred_initial_payload = median(deferred_initial, "payload_bytes")
    deferred_follow_up_payload = median(deferred_follow_up, "payload_bytes")
    deferred_total_payload = deferred_initial_payload + deferred_follow_up_payload
    capable_overhead = (
        median(blocking_capable, "duration_ms")
        - median(blocking_baseline, "duration_ms")
    )

    print("FluxFast controlled deferred-resource benchmark")
    print(f"workload: {samples} samples; fast=10 ms, medium=100 ms, slow=500 ms")
    print(format_measurement("blocking baseline initial", blocking_baseline))
    print(format_measurement("blocking capable initial", blocking_capable))
    print(format_measurement("deferred initial", deferred_initial))
    print(format_measurement("deferred follow-up", deferred_follow_up))
    print(
        "deferred settlement: "
        f"{statistics.median(deferred_settlement_ms):.2f} ms median across two requests"
    )
    print(f"capability-only blocking delta: {capable_overhead:+.2f} ms median")
    print(
        "payload tradeoff: "
        f"blocking={blocking_payload:.0f} bytes; "
        f"deferred initial={deferred_initial_payload:.0f} bytes; "
        f"deferred settled total={deferred_total_payload:.0f} bytes"
    )
    print(
        "loader counts: "
        + ", ".join(
            f"{key}={loader_counts[key]}"
            for key in sorted(loader_counts)
        )
    )
    print(
        "correctness: PASS — initial deferred response ran only fast; "
        "follow-up ran medium+slow; blocking resources stayed immediate"
    )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--samples",
        type=int,
        default=3,
        help="number of complete blocking/deferred comparisons (default: 3)",
    )
    return parser.parse_args()


if __name__ == "__main__":
    run_benchmark(parse_args().samples)
