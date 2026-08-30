"""Measure Live Resource fan-out, convergence, queue bounds, and cleanup."""

from __future__ import annotations

import argparse
import asyncio
import gc
import statistics
import time
import tracemalloc
from collections.abc import AsyncIterator

import anyio
import anyio.lowlevel
from fastapi import FastAPI
from fastapi.testclient import TestClient
from fluxfast import (
    CAPABILITY_LIVE_RESOURCES,
    FluxFast,
    LiveEvent,
    LiveInvalidateEvent,
    MemoryLiveBroker,
    Page,
    derive_live_topic,
    resource,
    scope,
)
from fluxfast.headers import HEADER_CAPABILITIES, HEADER_FLUXFAST, HEADER_ONLY

CONNECTION_COUNTS = (1, 10, 100, 500)
TOPIC = "benchmark.live"


async def wait_for_subscribers(broker: MemoryLiveBroker, count: int) -> None:
    """Wait for deterministic registration without imposing a performance gate."""

    with anyio.fail_after(10):
        while broker.subscriber_count != count:
            await anyio.lowlevel.checkpoint()


async def cancel_receivers(tasks: list[asyncio.Task[LiveEvent]]) -> None:
    for task in tasks:
        task.cancel()
    await asyncio.gather(*tasks, return_exceptions=True)


async def benchmark_connection_creation() -> dict[int, float]:
    results: dict[int, float] = {}
    for count in CONNECTION_COUNTS:
        broker = MemoryLiveBroker()
        streams = [broker.subscribe({TOPIC}) for _ in range(count)]
        started = time.perf_counter()
        tasks = [asyncio.create_task(anext(stream)) for stream in streams]
        await wait_for_subscribers(broker, count)
        results[count] = (time.perf_counter() - started) * 1_000

        await cancel_receivers(tasks)
        assert broker.subscriber_count == 0
        assert broker.pending_event_count == 0
        await broker.close()
    return results


async def benchmark_publish_latency(samples: int) -> list[float]:
    broker = MemoryLiveBroker()
    stream = broker.subscribe({TOPIC})
    pending = asyncio.create_task(anext(stream))
    await wait_for_subscribers(broker, 1)
    results: list[float] = []

    for sample in range(samples):
        if sample > 0:
            pending = asyncio.create_task(anext(stream))
            await anyio.lowlevel.checkpoint()
        event = LiveInvalidateEvent(keys=["summary"])
        started = time.perf_counter()
        await broker.publish(TOPIC, event)
        received = await pending
        results.append((time.perf_counter() - started) * 1_000)
        assert received == event

    await stream.aclose()
    assert broker.subscriber_count == 0
    await broker.close()
    return results


async def benchmark_invalidation_convergence(samples: int) -> list[float]:
    app = FastAPI()
    broker = MemoryLiveBroker()
    flux = FluxFast(app, broker=broker)
    resource_scope = scope.public()
    state = {"value": 0, "loader_calls": 0}

    def load_summary() -> dict[str, int]:
        state["loader_calls"] += 1
        return {"value": state["value"]}

    @flux.page("/live-benchmark")
    async def live_benchmark_page() -> Page:
        return Page(
            "benchmark/live",
            resources=[
                resource(
                    "summary",
                    load_summary,
                    scope=resource_scope,
                    ttl=60,
                    live=True,
                )
            ],
        )

    headers = {
        HEADER_FLUXFAST: "1",
        HEADER_CAPABILITIES: CAPABILITY_LIVE_RESOURCES,
    }
    client = TestClient(app)
    try:
        initial = client.get("/live-benchmark", headers=headers)
        initial.raise_for_status()
        assert initial.json()["resources"]["summary"]["value"] == {"value": 0}

        topic = derive_live_topic(resource_scope, "summary")
        stream: AsyncIterator[LiveEvent] = broker.subscribe({topic})
        pending = asyncio.create_task(anext(stream))
        await wait_for_subscribers(broker, 1)
        results: list[float] = []

        for sample in range(samples):
            if sample > 0:
                pending = asyncio.create_task(anext(stream))
                await anyio.lowlevel.checkpoint()
            state["value"] += 1
            started = time.perf_counter()
            await flux.live.invalidate("summary", scope=resource_scope)
            event = await pending
            assert event == LiveInvalidateEvent(keys=["summary"])
            refreshed = client.get(
                "/live-benchmark",
                headers={**headers, HEADER_ONLY: "summary"},
            )
            refreshed.raise_for_status()
            value = refreshed.json()["resources"]["summary"]["value"]
            results.append((time.perf_counter() - started) * 1_000)
            assert value == {"value": state["value"]}

        await stream.aclose()
        assert broker.subscriber_count == 0
        assert state["loader_calls"] == samples + 1
    finally:
        client.close()

    await flux.live.close()
    return results


async def benchmark_slow_subscriber(
    flood_events: int,
    queue_size: int,
) -> dict[str, int]:
    broker = MemoryLiveBroker(max_queue_size=queue_size)
    stream = broker.subscribe({TOPIC})
    first = asyncio.create_task(anext(stream))
    await wait_for_subscribers(broker, 1)
    await broker.publish(TOPIC, LiveInvalidateEvent(keys=["summary"]))
    assert await first == LiveInvalidateEvent(keys=["summary"])

    gc.collect()
    tracemalloc.start()
    baseline_bytes, _ = tracemalloc.get_traced_memory()
    for index in range(flood_events):
        await broker.publish(
            TOPIC,
            LiveInvalidateEvent(keys=[f"resource-{index % 10}"]),
        )
    current_bytes, peak_bytes = tracemalloc.get_traced_memory()

    pending_events = broker.pending_event_count
    overflow_count = broker.queue_overflow_count
    assert pending_events <= queue_size
    assert overflow_count > 0

    await stream.aclose()
    gc.collect()
    retained_bytes, _ = tracemalloc.get_traced_memory()
    tracemalloc.stop()
    assert broker.subscriber_count == 0
    assert broker.pending_event_count == 0
    await broker.close()
    return {
        "pending_events": pending_events,
        "overflow_count": overflow_count,
        "peak_bytes": max(0, peak_bytes - baseline_bytes),
        "retained_bytes": max(0, retained_bytes - baseline_bytes),
        "current_bytes": max(0, current_bytes - baseline_bytes),
    }


async def benchmark_repeated_cleanup(total_connections: int) -> float:
    broker = MemoryLiveBroker()
    batch_size = min(25, total_connections)
    remaining = total_connections
    started = time.perf_counter()

    while remaining > 0:
        count = min(batch_size, remaining)
        streams = [broker.subscribe({TOPIC}) for _ in range(count)]
        tasks = [asyncio.create_task(anext(stream)) for stream in streams]
        await wait_for_subscribers(broker, count)
        await cancel_receivers(tasks)
        assert broker.subscriber_count == 0
        assert broker.pending_event_count == 0
        remaining -= count

    duration_ms = (time.perf_counter() - started) * 1_000
    await broker.close()
    return duration_ms


def percentile(values: list[float], fraction: float) -> float:
    ordered = sorted(values)
    index = min(len(ordered) - 1, round((len(ordered) - 1) * fraction))
    return ordered[index]


def latency_summary(values: list[float]) -> str:
    return (
        f"{statistics.median(values):.3f} ms median, "
        f"{percentile(values, 0.95):.3f} ms p95"
    )


async def run_benchmark(
    samples: int,
    flood_events: int,
    cleanup_connections: int,
    queue_size: int,
) -> None:
    for name, value in (
        ("samples", samples),
        ("flood_events", flood_events),
        ("cleanup_connections", cleanup_connections),
        ("queue_size", queue_size),
    ):
        if value <= 0:
            raise ValueError(f"{name} must be positive")

    connection_results = await benchmark_connection_creation()
    publish_results = await benchmark_publish_latency(samples)
    convergence_results = await benchmark_invalidation_convergence(samples)
    queue_results = await benchmark_slow_subscriber(flood_events, queue_size)
    cleanup_ms = await benchmark_repeated_cleanup(cleanup_connections)

    print("FluxFast controlled Live Resource benchmark")
    print(
        f"workload: {samples} latency samples; {flood_events}-event slow-client "
        f"flood; {cleanup_connections} repeated connections"
    )
    for count, duration_ms in connection_results.items():
        print(f"connection creation ({count:>3}): {duration_ms:.3f} ms")
    print(f"publish to receive: {latency_summary(publish_results)}")
    print(
        "invalidation to canonical resource-only refresh: "
        f"{latency_summary(convergence_results)}"
    )
    print(
        "slow subscriber: "
        f"{queue_results['pending_events']}/{queue_size} events pending, "
        f"{queue_results['overflow_count']} overflows, "
        f"{queue_results['peak_bytes']} peak traced bytes, "
        f"{queue_results['retained_bytes']} retained traced bytes"
    )
    print(
        "connection cleanup: "
        f"{cleanup_connections} connections in {cleanup_ms:.3f} ms; "
        "active subscribers returned to 0"
    )
    print(
        "correctness: PASS — convergence completed with canonical state; "
        "slow-client queues stayed bounded; all subscriptions were cleaned up"
    )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--samples", type=int, default=25)
    parser.add_argument("--flood-events", type=int, default=10_000)
    parser.add_argument("--cleanup-connections", type=int, default=500)
    parser.add_argument("--queue-size", type=int, default=64)
    return parser.parse_args()


if __name__ == "__main__":
    arguments = parse_args()
    anyio.run(
        run_benchmark,
        arguments.samples,
        arguments.flood_events,
        arguments.cleanup_connections,
        arguments.queue_size,
    )
