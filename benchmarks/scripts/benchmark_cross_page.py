"""Measure complete-props transfer against FluxFast cross-page deltas."""

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


def run_benchmark() -> None:
    app, loader_counts = create_benchmark_app()
    client = TestClient(app)

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

    delta_resources = delta.json()["resources"]
    shared = {"auth", "hotel", "permissions", "settings"}
    assert shared.isdisjoint(delta_resources)
    assert {"room-types", "rooms"}.issubset(delta_resources)
    assert all(loader_counts[key] == 1 for key in shared)

    bytes_saved = baseline_measurement.payload_bytes - delta_measurement.payload_bytes
    reduction = bytes_saved / baseline_measurement.payload_bytes * 100

    print("FluxFast controlled cross-page benchmark")
    print(f"initial dashboard: {initial.duration_ms:.2f} ms, {initial.payload_bytes} bytes")
    print(
        "complete props: "
        f"{baseline_measurement.duration_ms:.2f} ms, "
        f"{baseline_measurement.payload_bytes} bytes"
    )
    print(
        "resource delta: "
        f"{delta_measurement.duration_ms:.2f} ms, "
        f"{delta_measurement.payload_bytes} bytes"
    )
    print(f"payload reduction: {reduction:.1f}% ({bytes_saved} bytes)")
    print(f"delta resources: {', '.join(sorted(delta_resources))}")
    print(f"baseline response bytes verified: {len(baseline.content)}")


if __name__ == "__main__":
    run_benchmark()
