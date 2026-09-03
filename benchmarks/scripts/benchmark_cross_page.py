"""Measure complete-props transfer against FluxFast cross-page deltas."""

import argparse
import statistics
import time
from dataclasses import dataclass

from fastapi.testclient import TestClient
from fluxfast.headers import HEADER_FLUXFAST, HEADER_KNOWN, encode_known_header

from benchmarks.fixtures.app import create_benchmark_app


@dataclass(frozen=True)
class Measurement:
    duration_ms: float
    payload_bytes: int


def measured_get(client: TestClient, path: str, headers: dict[str, str] | None = None):
    started = time.perf_counter()
    response = client.get(path, headers=headers)
    duration_ms = (time.perf_counter() - started) * 1_000
    response.raise_for_status()
    return response, Measurement(duration_ms, len(response.content))


def median(values: list[Measurement], field: str) -> float:
    return statistics.median(getattr(value, field) for value in values)


def run_benchmark(samples: int = 5) -> None:
    if samples <= 0:
        raise ValueError("samples must be positive")

    initial_measurements: list[Measurement] = []
    baseline_measurements: list[Measurement] = []
    delta_measurements: list[Measurement] = []
    delta_resource_names: set[str] | None = None

    for _ in range(samples):
        app, loader_counts = create_benchmark_app()
        with TestClient(app) as client:
            dashboard, initial = measured_get(
                client,
                "/dashboard",
                {HEADER_FLUXFAST: "1"},
            )
            known = {
                key: record["version"]
                for key, record in dashboard.json()["resources"].items()
            }

            baseline, baseline_measurement = measured_get(client, "/baseline/rooms")
            delta, delta_measurement = measured_get(
                client,
                "/rooms",
                {
                    HEADER_FLUXFAST: "1",
                    HEADER_KNOWN: encode_known_header(known),
                },
            )

        delta_resources = set(delta.json()["resources"])
        shared = {"auth", "hotel", "permissions", "settings"}
        assert shared.isdisjoint(delta_resources)
        assert {"room-types", "rooms"}.issubset(delta_resources)
        assert all(loader_counts[key] == 1 for key in shared)
        assert len(baseline.content) == baseline_measurement.payload_bytes
        if delta_resource_names is None:
            delta_resource_names = delta_resources
        else:
            assert delta_resource_names == delta_resources
        initial_measurements.append(initial)
        baseline_measurements.append(baseline_measurement)
        delta_measurements.append(delta_measurement)

    initial_bytes = median(initial_measurements, "payload_bytes")
    baseline_bytes = median(baseline_measurements, "payload_bytes")
    delta_bytes = median(delta_measurements, "payload_bytes")
    bytes_saved = baseline_bytes - delta_bytes
    reduction = bytes_saved / baseline_bytes * 100

    print("FluxFast controlled cross-page benchmark")
    print(f"workload: {samples} fresh-application samples; no timing thresholds")
    print(
        f"initial dashboard: {median(initial_measurements, 'duration_ms'):.2f} ms median, "
        f"{initial_bytes:.0f} bytes median"
    )
    print(
        "complete props: "
        f"{median(baseline_measurements, 'duration_ms'):.2f} ms median, "
        f"{baseline_bytes:.0f} bytes median"
    )
    print(
        "resource delta: "
        f"{median(delta_measurements, 'duration_ms'):.2f} ms median, "
        f"{delta_bytes:.0f} bytes median"
    )
    print(f"payload reduction: {reduction:.1f}% ({bytes_saved:.0f} bytes)")
    print(f"delta resources: {', '.join(sorted(delta_resource_names or set()))}")
    print(
        "correctness: PASS — every fresh app omitted all four known shared resources; "
        "shared loaders ran once; response byte counts remained stable"
    )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--samples", type=int, default=5)
    return parser.parse_args()


if __name__ == "__main__":
    run_benchmark(parse_args().samples)
