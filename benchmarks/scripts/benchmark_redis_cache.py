"""Measure local and distributed resource-cache behavior with real Redis."""

from __future__ import annotations

import argparse
import asyncio
import os
import socket
import statistics
import subprocess
import sys
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from uuid import uuid4

import httpx2
from fluxfast import CachedResource, MemoryResourceCache, RedisResourceCache
from fluxfast.headers import HEADER_FLUXFAST, HEADER_KNOWN, encode_known_header
from redis.asyncio import Redis

PAYLOAD_SIZES = (1024, 10 * 1024, 100 * 1024, 1024 * 1024)
WORKER_COUNTS = (1, 2, 4, 8)
FLUXFAST_HEADERS = {HEADER_FLUXFAST: "1"}
FIXTURE_DIRECTORY = Path(__file__).parents[1] / "fixtures"


@dataclass(frozen=True, slots=True)
class PayloadMeasurement:
    requested_bytes: int
    serialized_bytes: int
    memory_set_ms: list[float]
    memory_get_ms: list[float]
    redis_set_ms: list[float]
    redis_get_ms: list[float]


@dataclass(frozen=True, slots=True)
class WorkerMeasurement:
    workers: int
    cold_loader_executions: int
    cold_fanout_ms: float
    warm_loader_executions: int
    redis_reads: int
    redis_writes: int
    throughput_per_second: float
    hit_latency_ms: list[float]
    known_version_omissions: int


def percentile(values: list[float], fraction: float) -> float:
    ordered = sorted(values)
    index = min(len(ordered) - 1, round((len(ordered) - 1) * fraction))
    return ordered[index]


def latency_summary(values: list[float]) -> str:
    return (
        f"{statistics.median(values):.3f} ms median, "
        f"{percentile(values, 0.95):.3f} ms p95"
    )


async def measure(operation: Callable[[], Awaitable[Any]]) -> float:
    started = time.perf_counter()
    await operation()
    return (time.perf_counter() - started) * 1_000


async def benchmark_payloads(
    redis_url: str,
    samples: int,
) -> tuple[list[PayloadMeasurement], list[float]]:
    namespace = f"benchmark-payloads-{uuid4().hex}"
    memory = MemoryResourceCache(max_entries=64)
    writer = RedisResourceCache.from_url(
        redis_url,
        namespace=namespace,
        max_value_bytes=2 * max(PAYLOAD_SIZES),
    )
    reader = RedisResourceCache.from_url(
        redis_url,
        namespace=namespace,
        max_value_bytes=2 * max(PAYLOAD_SIZES),
    )
    results: list[PayloadMeasurement] = []
    tag_invalidation_ms: list[float] = []

    try:
        await writer.clear()
        for requested_bytes in PAYLOAD_SIZES:
            key = f"payload:{requested_bytes}"
            value = {"payload": "x" * requested_bytes}
            entry = CachedResource(
                version=f"v-{requested_bytes}",
                value=value,
                expires_at=0,
                tags=("payload",),
            )
            memory_set_ms: list[float] = []
            memory_get_ms: list[float] = []
            redis_set_ms: list[float] = []
            redis_get_ms: list[float] = []
            before_written = writer.metrics.snapshot().cache_payload_bytes_written

            for _ in range(samples):
                memory_set_ms.append(
                    await measure(
                        lambda key=key, entry=entry: memory.set(
                            key,
                            entry,
                            ttl=60,
                        )
                    )
                )
                memory_get_ms.append(
                    await measure(lambda key=key: memory.get(key))
                )
                redis_set_ms.append(
                    await measure(
                        lambda key=key, entry=entry: writer.set(
                            key,
                            entry,
                            ttl=60,
                        )
                    )
                )

                async def read_and_verify(
                    key: str = key,
                    entry: CachedResource = entry,
                    value: dict[str, str] = value,
                ) -> None:
                    cached = await reader.get(key)
                    assert cached is not None
                    assert cached.version == entry.version
                    assert cached.value == value
                    assert cached.tags == entry.tags

                redis_get_ms.append(await measure(read_and_verify))

            written = (
                writer.metrics.snapshot().cache_payload_bytes_written
                - before_written
            )
            assert written > requested_bytes * samples
            results.append(
                PayloadMeasurement(
                    requested_bytes=requested_bytes,
                    serialized_bytes=written // samples,
                    memory_set_ms=memory_set_ms,
                    memory_get_ms=memory_get_ms,
                    redis_set_ms=redis_set_ms,
                    redis_get_ms=redis_get_ms,
                )
            )

        for sample in range(samples):
            tag = f"group:{sample}"
            keys = [f"tag:{sample}:{index}" for index in range(100)]
            for key in keys:
                await writer.set(
                    key,
                    CachedResource(
                        version="tagged",
                        value={"payload": "x" * 1024},
                        expires_at=0,
                        tags=(tag,),
                    ),
                    ttl=60,
                )
            tag_invalidation_ms.append(
                await measure(lambda tag=tag: writer.invalidate_tag(tag))
            )
            assert all([await reader.get(key) is None for key in keys])
    finally:
        try:
            await writer.clear()
        finally:
            await writer.close()
            await reader.close()

    return results, tag_invalidation_ms


def available_port() -> int:
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        return int(listener.getsockname()[1])


def start_worker(port: int, environment: dict[str, str]) -> subprocess.Popen:
    return subprocess.Popen(
        [
            sys.executable,
            "-m",
            "uvicorn",
            "redis_worker:app",
            "--app-dir",
            str(FIXTURE_DIRECTORY),
            "--host",
            "127.0.0.1",
            "--port",
            str(port),
            "--log-level",
            "warning",
            "--no-access-log",
        ],
        env=environment,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.STDOUT,
    )


async def wait_for_workers(
    client: httpx2.AsyncClient,
    workers: list[tuple[int, subprocess.Popen]],
) -> None:
    pending = set(range(len(workers)))
    deadline = time.monotonic() + 20
    while pending:
        if time.monotonic() >= deadline:
            raise TimeoutError("Redis benchmark workers did not become ready")
        for index in tuple(pending):
            port, process = workers[index]
            if process.poll() is not None:
                raise RuntimeError(
                    f"Redis benchmark worker on port {port} exited during startup"
                )
            try:
                response = await client.get(f"http://127.0.0.1:{port}/health")
                response.raise_for_status()
            except httpx2.HTTPError:
                continue
            assert response.json() == {"pid": process.pid}
            pending.remove(index)
        if pending:
            await asyncio.sleep(0.05)


def stop_workers(workers: list[tuple[int, subprocess.Popen]]) -> None:
    for _port, process in workers:
        if process.poll() is None:
            process.terminate()
    for _port, process in workers:
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)


async def worker_metrics(
    client: httpx2.AsyncClient,
    ports: list[int],
) -> dict[int, dict[str, int]]:
    snapshots: dict[int, dict[str, int]] = {}
    for port in ports:
        response = await client.get(f"http://127.0.0.1:{port}/metrics")
        response.raise_for_status()
        payload = response.json()
        pid = int(payload["pid"])
        metrics = payload["metrics"]
        assert isinstance(metrics, dict)
        snapshots[pid] = {str(key): int(value) for key, value in metrics.items()}
    assert len(snapshots) == len(ports)
    return snapshots


def metric_delta(
    before: dict[int, dict[str, int]],
    after: dict[int, dict[str, int]],
    name: str,
) -> int:
    return sum(
        after[pid][name] - before[pid][name]
        for pid in before
    )


async def loader_count(admin: Redis, key: str) -> int:
    raw_count = await admin.get(key)
    return 0 if raw_count is None else int(raw_count)


async def benchmark_worker_count(
    redis_url: str,
    worker_count: int,
    warm_requests: int,
) -> WorkerMeasurement:
    deployment = uuid4().hex
    namespace = f"benchmark-workers-{deployment}"
    state_key = f"fluxfast:benchmark:{deployment}:state"
    load_count_key = f"fluxfast:benchmark:{deployment}:loads"
    environment = os.environ.copy()
    environment.update(
        {
            "FLUXFAST_BENCHMARK_REDIS_URL": redis_url,
            "FLUXFAST_BENCHMARK_CACHE_NAMESPACE": namespace,
            "FLUXFAST_BENCHMARK_STATE_KEY": state_key,
            "FLUXFAST_BENCHMARK_LOAD_COUNT_KEY": load_count_key,
        }
    )
    ports: list[int] = []
    while len(ports) < worker_count:
        port = available_port()
        if port not in ports:
            ports.append(port)
    workers = [(port, start_worker(port, environment)) for port in ports]
    admin = Redis.from_url(redis_url)
    cleanup_cache = RedisResourceCache.from_url(redis_url, namespace=namespace)

    try:
        await admin.set(state_key, 1)
        await admin.delete(load_count_key)
        async with httpx2.AsyncClient(timeout=20) as client:
            await wait_for_workers(client, workers)

            cold_started = time.perf_counter()
            cold_responses = await asyncio.gather(
                *(
                    client.get(
                        f"http://127.0.0.1:{port}/resource",
                        headers=FLUXFAST_HEADERS,
                    )
                    for port in ports
                )
            )
            cold_fanout_ms = (time.perf_counter() - cold_started) * 1_000
            for response in cold_responses:
                response.raise_for_status()
                assert response.json()["resources"]["benchmark"]["value"] == {
                    "value": 1
                }
            cold_loads = await loader_count(admin, load_count_key)
            assert 1 <= cold_loads <= worker_count
            baseline_metrics = await worker_metrics(client, ports)

            await cleanup_cache.clear()
            await admin.delete(load_count_key)
            seed = await client.get(
                f"http://127.0.0.1:{ports[0]}/resource",
                headers=FLUXFAST_HEADERS,
            )
            seed.raise_for_status()
            seed_record = seed.json()["resources"]["benchmark"]

            async def warm_request(index: int) -> float:
                started = time.perf_counter()
                response = await client.get(
                    f"http://127.0.0.1:{ports[index % worker_count]}/resource",
                    headers=FLUXFAST_HEADERS,
                )
                duration_ms = (time.perf_counter() - started) * 1_000
                response.raise_for_status()
                assert response.json()["resources"]["benchmark"] == seed_record
                return duration_ms

            warm_started = time.perf_counter()
            hit_latency_ms = await asyncio.gather(
                *(warm_request(index) for index in range(warm_requests))
            )
            warm_duration = time.perf_counter() - warm_started

            known_headers = {
                **FLUXFAST_HEADERS,
                HEADER_KNOWN: encode_known_header(
                    {"benchmark": seed_record["version"]}
                ),
            }
            known_responses = await asyncio.gather(
                *(
                    client.get(
                        f"http://127.0.0.1:{port}/resource",
                        headers=known_headers,
                    )
                    for port in ports
                )
            )
            omissions = 0
            for response in known_responses:
                response.raise_for_status()
                if response.json()["resources"] == {}:
                    omissions += 1
            assert omissions == worker_count

            final_metrics = await worker_metrics(client, ports)
            warm_loads = await loader_count(admin, load_count_key)
            assert warm_loads == 1
            redis_reads = metric_delta(
                baseline_metrics,
                final_metrics,
                "cache_gets",
            )
            redis_writes = metric_delta(
                baseline_metrics,
                final_metrics,
                "cache_sets",
            )
            assert redis_reads == 1 + warm_requests + worker_count
            assert redis_writes == 1

            return WorkerMeasurement(
                workers=worker_count,
                cold_loader_executions=cold_loads,
                cold_fanout_ms=cold_fanout_ms,
                warm_loader_executions=warm_loads,
                redis_reads=redis_reads,
                redis_writes=redis_writes,
                throughput_per_second=warm_requests / warm_duration,
                hit_latency_ms=hit_latency_ms,
                known_version_omissions=omissions,
            )
    finally:
        stop_workers(workers)
        try:
            await cleanup_cache.clear()
            await admin.delete(state_key, load_count_key)
        finally:
            await cleanup_cache.close()
            await admin.aclose()


async def run_benchmark(
    redis_url: str,
    samples: int,
    warm_requests: int,
) -> None:
    if samples <= 0:
        raise ValueError("samples must be positive")
    if warm_requests <= 0:
        raise ValueError("warm_requests must be positive")

    probe = Redis.from_url(redis_url)
    try:
        await probe.ping()
    except Exception as error:
        raise RuntimeError(
            f"Redis is unavailable at {redis_url}; start Redis or pass --redis-url"
        ) from error
    finally:
        await probe.aclose()

    payload_results, tag_results = await benchmark_payloads(redis_url, samples)
    worker_results = [
        await benchmark_worker_count(redis_url, count, warm_requests)
        for count in WORKER_COUNTS
    ]

    print("FluxFast controlled distributed resource-cache benchmark")
    print(
        f"workload: {samples} samples per 1/10/100/1024 KiB payload; "
        f"100 entries per tag invalidation; {warm_requests} warm HTTP requests "
        "per 1/2/4/8-worker run"
    )
    print("payload operations (Redis reads use a separate client):")
    for result in payload_results:
        print(
            f"  {result.requested_bytes // 1024:>4} KiB requested, "
            f"{result.serialized_bytes} B serialized — "
            f"memory set {latency_summary(result.memory_set_ms)}; "
            f"memory get {latency_summary(result.memory_get_ms)}; "
            f"Redis set {latency_summary(result.redis_set_ms)}; "
            f"Redis cross-client get {latency_summary(result.redis_get_ms)}"
        )
    print(
        "Redis tag invalidation (100 entries): "
        f"{latency_summary(tag_results)}"
    )
    print("multi-worker shared-resource HTTP workload:")
    for result in worker_results:
        print(
            f"  {result.workers} worker(s) — cold fan-out "
            f"{result.cold_fanout_ms:.3f} ms / "
            f"{result.cold_loader_executions} loader execution(s); warm "
            f"{result.throughput_per_second:.1f} req/s; hit "
            f"{latency_summary(result.hit_latency_ms)}; "
            f"{result.warm_loader_executions} loader execution; "
            f"{result.redis_reads} Redis reads; {result.redis_writes} Redis write; "
            f"{result.known_version_omissions}/{result.workers} known-version "
            "omissions"
        )
    print(
        "tradeoff: Redis adds serialization and network work in exchange for "
        "cache coherence across independent workers; simultaneous cold misses "
        "may still execute duplicate loaders because FluxFast has no distributed lease"
    )
    print(
        "correctness: PASS — every cross-client payload round-tripped exactly; "
        "tag invalidation removed all tagged entries; ordinary warm traffic kept "
        "one loader execution at every worker count; known versions were omitted"
    )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--redis-url",
        default=os.getenv(
            "FLUXFAST_BENCHMARK_REDIS_URL",
            os.getenv("FLUXFAST_TEST_REDIS_URL", "redis://127.0.0.1:6379/15"),
        ),
    )
    parser.add_argument("--samples", type=int, default=5)
    parser.add_argument("--warm-requests", type=int, default=64)
    return parser.parse_args()


if __name__ == "__main__":
    arguments = parse_args()
    asyncio.run(
        run_benchmark(
            arguments.redis_url,
            arguments.samples,
            arguments.warm_requests,
        )
    )
