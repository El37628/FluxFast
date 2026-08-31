"""Process-level FastAPI coverage for Redis-backed resource coherence."""

from __future__ import annotations

import os
import socket
import subprocess
import sys
from pathlib import Path
from uuid import uuid4

import anyio
import httpx2
import pytest

from fluxfast import CAPABILITY_DEFERRED_RESOURCES, RedisResourceCache

REDIS_URL = os.getenv("FLUXFAST_TEST_REDIS_URL")
pytestmark = pytest.mark.skipif(
    REDIS_URL is None,
    reason="set FLUXFAST_TEST_REDIS_URL to run real Redis integration tests",
)

_FIXTURE_DIRECTORY = Path(__file__).parent / "fixtures"
_FLUXFAST_HEADERS = {"X-FluxFast": "1"}
_DEFERRED_HEADERS = {
    **_FLUXFAST_HEADERS,
    "X-FluxFast-Capabilities": CAPABILITY_DEFERRED_RESOURCES,
}


def _available_port() -> int:
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        return int(listener.getsockname()[1])


def _start_worker(port: int, environment: dict[str, str]) -> subprocess.Popen:
    return subprocess.Popen(
        [
            sys.executable,
            "-m",
            "uvicorn",
            "redis_worker_app:app",
            "--app-dir",
            str(_FIXTURE_DIRECTORY),
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


async def _wait_for_workers(
    client: httpx2.AsyncClient,
    workers: list[tuple[int, subprocess.Popen]],
) -> None:
    pending = set(range(len(workers)))
    with anyio.fail_after(15):
        while pending:
            for index in tuple(pending):
                port, process = workers[index]
                if process.poll() is not None:
                    raise AssertionError(
                        f"Redis worker on port {port} exited during startup"
                    )
                try:
                    response = await client.get(f"http://127.0.0.1:{port}/health")
                    response.raise_for_status()
                except httpx2.HTTPError:
                    continue
                assert response.json() == {"pid": process.pid}
                pending.remove(index)
            if pending:
                await anyio.sleep(0.05)


def _stop_workers(workers: list[tuple[int, subprocess.Popen]]) -> None:
    for _port, process in workers:
        if process.poll() is None:
            process.terminate()
    for _port, process in workers:
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)


@pytest.mark.anyio
async def test_three_fastapi_workers_share_invalidation_and_refill() -> None:
    assert REDIS_URL is not None
    from redis.asyncio import Redis

    deployment = uuid4().hex
    namespace = f"test-workers-{deployment}"
    state_key = f"fluxfast:test:{deployment}:state"
    load_count_key = f"fluxfast:test:{deployment}:loads"
    environment = os.environ.copy()
    environment.update(
        {
            "FLUXFAST_TEST_REDIS_URL": REDIS_URL,
            "FLUXFAST_TEST_CACHE_NAMESPACE": namespace,
            "FLUXFAST_TEST_LIVE_PREFIX": f"fluxfast:{namespace}:live:",
            "FLUXFAST_TEST_STATE_KEY": state_key,
            "FLUXFAST_TEST_LOAD_COUNT_KEY": load_count_key,
        }
    )
    ports: list[int] = []
    while len(ports) < 3:
        port = _available_port()
        if port not in ports:
            ports.append(port)
    workers = [(port, _start_worker(port, environment)) for port in ports]
    assert len({process.pid for _port, process in workers}) == 3
    admin = Redis.from_url(REDIS_URL)
    cleanup_cache = RedisResourceCache.from_url(REDIS_URL, namespace=namespace)

    try:
        await admin.set(state_key, 1)
        await admin.delete(load_count_key)
        async with httpx2.AsyncClient(timeout=5) as client:
            await _wait_for_workers(client, workers)

            first = await client.get(
                f"http://127.0.0.1:{ports[0]}/counter",
                headers=_FLUXFAST_HEADERS,
            )
            first.raise_for_status()
            first_record = first.json()["resources"]["counter"]
            assert first_record["value"] == {"value": 1}
            assert first.headers["X-FluxFast-Test-Worker"] == str(
                workers[0][1].pid
            )
            assert int(await admin.get(load_count_key)) == 1

            warm = await client.get(
                f"http://127.0.0.1:{ports[1]}/counter",
                headers=_FLUXFAST_HEADERS,
            )
            warm.raise_for_status()
            assert warm.json()["resources"]["counter"] == first_record
            assert warm.headers["X-FluxFast-Test-Worker"] == str(
                workers[1][1].pid
            )
            assert int(await admin.get(load_count_key)) == 1

            mutation = await client.post(
                f"http://127.0.0.1:{ports[2]}/counter/increment",
                headers=_FLUXFAST_HEADERS,
            )
            mutation.raise_for_status()
            assert mutation.json()["mutation"]["invalidate"] == ["counter"]
            assert mutation.headers["X-FluxFast-Test-Worker"] == str(
                workers[2][1].pid
            )

            refill = await client.get(
                f"http://127.0.0.1:{ports[1]}/counter",
                headers=_FLUXFAST_HEADERS,
            )
            refill.raise_for_status()
            refill_record = refill.json()["resources"]["counter"]
            assert refill_record["value"] == {"value": 2}
            assert refill_record["version"] != first_record["version"]
            assert int(await admin.get(load_count_key)) == 2

            shared = await client.get(
                f"http://127.0.0.1:{ports[0]}/counter",
                headers=_FLUXFAST_HEADERS,
            )
            shared.raise_for_status()
            assert shared.json()["resources"]["counter"] == refill_record
            assert int(await admin.get(load_count_key)) == 2
    finally:
        _stop_workers(workers)
        try:
            await cleanup_cache.clear()
            await admin.delete(state_key, load_count_key)
        finally:
            await cleanup_cache.close()
            await admin.aclose()


@pytest.mark.anyio
async def test_deferred_resource_follow_up_populates_shared_worker_cache() -> None:
    assert REDIS_URL is not None
    from redis.asyncio import Redis

    deployment = uuid4().hex
    namespace = f"test-deferred-workers-{deployment}"
    state_key = f"fluxfast:test:{deployment}:analytics"
    load_count_key = f"fluxfast:test:{deployment}:analytics-loads"
    environment = os.environ.copy()
    environment.update(
        {
            "FLUXFAST_TEST_REDIS_URL": REDIS_URL,
            "FLUXFAST_TEST_CACHE_NAMESPACE": namespace,
            "FLUXFAST_TEST_LIVE_PREFIX": f"fluxfast:{namespace}:live:",
            "FLUXFAST_TEST_STATE_KEY": state_key,
            "FLUXFAST_TEST_LOAD_COUNT_KEY": load_count_key,
        }
    )
    ports: list[int] = []
    while len(ports) < 3:
        port = _available_port()
        if port not in ports:
            ports.append(port)
    workers = [(port, _start_worker(port, environment)) for port in ports]
    assert len({process.pid for _port, process in workers}) == 3
    admin = Redis.from_url(REDIS_URL)
    cleanup_cache = RedisResourceCache.from_url(REDIS_URL, namespace=namespace)

    try:
        await admin.set(state_key, 42)
        await admin.delete(load_count_key)
        async with httpx2.AsyncClient(timeout=5) as client:
            await _wait_for_workers(client, workers)

            cold = await client.get(
                f"http://127.0.0.1:{ports[0]}/analytics",
                headers=_DEFERRED_HEADERS,
            )
            cold.raise_for_status()
            assert cold.json()["resources"] == {}
            assert cold.json()["resourceKeys"] == ["analytics"]
            assert cold.json()["deferred"] == ["analytics"]
            assert cold.headers["X-FluxFast-Deferred-Pending"] == "1"
            assert cold.headers["X-FluxFast-Test-Worker"] == str(
                workers[0][1].pid
            )
            assert await admin.get(load_count_key) is None

            follow_up = await client.get(
                f"http://127.0.0.1:{ports[1]}/analytics",
                headers={**_DEFERRED_HEADERS, "X-FluxFast-Only": "analytics"},
            )
            follow_up.raise_for_status()
            analytics_record = follow_up.json()["resources"]["analytics"]
            assert analytics_record["value"] == {"visits": 42}
            assert "deferred" not in follow_up.json()
            assert follow_up.headers["X-FluxFast-Deferred-Pending"] == "0"
            assert follow_up.headers["X-FluxFast-Test-Worker"] == str(
                workers[1][1].pid
            )
            assert int(await admin.get(load_count_key)) == 1

            shared_hit = await client.get(
                f"http://127.0.0.1:{ports[2]}/analytics",
                headers=_DEFERRED_HEADERS,
            )
            shared_hit.raise_for_status()
            assert shared_hit.json()["resources"]["analytics"] == analytics_record
            assert "deferred" not in shared_hit.json()
            assert shared_hit.headers["X-FluxFast-Deferred-Pending"] == "0"
            assert shared_hit.headers["X-FluxFast-Test-Worker"] == str(
                workers[2][1].pid
            )
            assert int(await admin.get(load_count_key)) == 1
    finally:
        _stop_workers(workers)
        try:
            await cleanup_cache.clear()
            await admin.delete(state_key, load_count_key)
        finally:
            await cleanup_cache.close()
            await admin.aclose()
