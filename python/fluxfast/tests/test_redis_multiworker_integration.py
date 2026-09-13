"""Process-level FastAPI coverage for Redis-backed resource coherence."""

from __future__ import annotations

import json
import os
import signal
import socket
import subprocess
import sys
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit
from uuid import uuid4

import anyio
import httpx2
import pytest

from fluxfast import (
    CAPABILITY_DEFERRED_RESOURCES,
    CAPABILITY_LIVE_RESOURCES,
    RedisResourceCache,
    derive_live_topic,
    scope,
)

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
_DEFERRED_LIVE_HEADERS = {
    **_FLUXFAST_HEADERS,
    "X-FluxFast-Capabilities": (
        f"{CAPABILITY_DEFERRED_RESOURCES},{CAPABILITY_LIVE_RESOURCES}"
    ),
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


async def _next_sse_payload(lines: AsyncIterator[str]) -> dict[str, object]:
    async for line in lines:
        if line.startswith("data: "):
            payload = json.loads(line.removeprefix("data: "))
            assert isinstance(payload, dict)
            return payload
    raise AssertionError("live stream closed before the expected event")


def _live_headers(keys: str, session: str | None = None) -> dict[str, str]:
    headers = {
        **_FLUXFAST_HEADERS,
        "Accept": "text/event-stream",
        "X-FluxFast-Capabilities": CAPABILITY_LIVE_RESOURCES,
        "X-FluxFast-Protocol": "1",
        "X-FluxFast-Live": "1",
        "X-FluxFast-Live-Keys": keys,
    }
    if session is not None:
        headers["Cookie"] = f"fixture-session=session-{session}"
    return headers


async def _wait_for_worker_subscription(client: httpx2.AsyncClient, url: str) -> None:
    # An SSE ready frame can precede the asynchronous Redis subscribe ACK.
    with anyio.fail_after(5):
        while True:
            response = await client.get(f"{url}/metrics")
            response.raise_for_status()
            if response.json()["subscribers"] == 1:
                return
            await anyio.sleep(0.01)


async def _read_after_connection_drop(
    client: httpx2.AsyncClient, url: str, admin, load_key: str
) -> httpx2.Response:
    # Supported redis-py retry defaults differ. Every unsuccessful GET remains
    # a strict transport error, with no loader/local-memory fallback, until a
    # bounded caller-initiated retry re-establishes the connection.
    previous_loads = await admin.get(load_key)
    with anyio.fail_after(5):
        while True:
            response = await client.get(url, headers=_FLUXFAST_HEADERS)
            if response.status_code == 200:
                return response
            assert response.status_code == 500
            assert response.json()["error"]["type"] == "ResourceCacheUnavailableError"
            assert await admin.get(load_key) == previous_loads
            await anyio.sleep(0.01)


@asynccontextmanager
async def _gate_workers(overrides: dict[str, str] | None = None):
    """Own three real workers and only this run's Redis keys/namespace."""
    assert REDIS_URL is not None
    from redis.asyncio import Redis

    deployment = uuid4().hex
    namespace = f"test-gate-{deployment}"
    prefix = f"fluxfast:test:{deployment}"
    environment = {
        **os.environ,
        "FLUXFAST_TEST_REDIS_URL": REDIS_URL,
        "FLUXFAST_TEST_CACHE_NAMESPACE": namespace,
        "FLUXFAST_TEST_LIVE_PREFIX": f"fluxfast:{namespace}:live:",
        "FLUXFAST_TEST_STATE_KEY": f"{prefix}:state",
        "FLUXFAST_TEST_LOAD_COUNT_KEY": f"{prefix}:loads",
        **(overrides or {}),
    }
    admin = Redis.from_url(REDIS_URL)
    cleanup = RedisResourceCache.from_url(REDIS_URL, namespace=namespace)
    workers = []
    try:
        await admin.set(f"{prefix}:state", 1)
        ports = []
        while len(ports) < 3:
            port = _available_port()
            if port not in ports:
                ports.append(port)
        for port in ports:
            workers.append((port, _start_worker(port, environment)))
        async with httpx2.AsyncClient(timeout=5) as client:
            await _wait_for_workers(client, workers)
            yield (
                client,
                [f"http://127.0.0.1:{port}" for port in ports],
                admin,
                prefix,
                workers,
            )
    finally:
        _stop_workers(workers)
        try:
            await cleanup.clear()
            keys = [key async for key in admin.scan_iter(match=f"{prefix}:*")]
            if keys:
                await admin.delete(*keys)
        finally:
            await cleanup.close()
            await admin.aclose()


@pytest.mark.anyio
@pytest.mark.parametrize(
    "kind,key,other,other_owner",
    [
        ("user", "user-counter", "bob", "bob"),
        ("tenant", "tenant-counter", "carol", "tenant-b"),
    ],
)
async def test_authenticated_scopes_isolate_cache_and_cross_worker_live_events(
    kind: str,
    key: str,
    other: str,
    other_owner: str,
) -> None:
    owner = "alice" if kind == "user" else "tenant-a"
    async with _gate_workers() as (client, urls, admin, prefix, _workers):
        headers_a = {**_FLUXFAST_HEADERS, "Cookie": "fixture-session=session-alice"}
        headers_b = {**_FLUXFAST_HEADERS, "Cookie": f"fixture-session=session-{other}"}
        first = await client.get(f"{urls[0]}/scoped", headers=headers_a)
        first.raise_for_status()
        first_record = first.json()["resources"][key]
        assert first_record["value"] == {"owner": owner, "value": 0}
        warm = await client.get(f"{urls[1]}/scoped", headers=headers_a)
        warm.raise_for_status()
        assert warm.json()["resources"][key] == first_record
        assert int(await admin.get(f"{prefix}:loads:{kind}:{owner}")) == 1
        other_page = await client.get(f"{urls[1]}/scoped", headers=headers_b)
        other_page.raise_for_status()
        assert other_page.json()["resources"][key]["value"] == {
            "owner": other_owner,
            "value": 0,
        }

        # Bob shares tenant-a but never alice's user scope/cache identity.
        bob = await client.get(
            f"{urls[2]}/scoped",
            headers={**_FLUXFAST_HEADERS, "Cookie": "fixture-session=session-bob"},
        )
        bob.raise_for_status()
        assert (
            bob.json()["resources"]["tenant-counter"]
            == first.json()["resources"]["tenant-counter"]
        )
        assert bob.json()["resources"]["user-counter"]["value"]["owner"] == "bob"
        assert int(await admin.get(f"{prefix}:loads:tenant:tenant-a")) == 1

        async with (
            client.stream(
                "GET", f"{urls[0]}/scoped", headers=_live_headers(key, "alice")
            ) as stream_a,
            client.stream(
                "GET", f"{urls[1]}/scoped", headers=_live_headers(key, other)
            ) as stream_b,
        ):
            stream_a.raise_for_status()
            stream_b.raise_for_status()
            lines_a, lines_b = stream_a.aiter_lines(), stream_b.aiter_lines()
            with anyio.fail_after(5):
                assert (await _next_sse_payload(lines_a))["keys"] == [key]
                assert (await _next_sse_payload(lines_b))["keys"] == [key]
            await _wait_for_worker_subscription(client, urls[0])
            await _wait_for_worker_subscription(client, urls[1])
            # A signal on the wrong scope would be queued before the next own
            # signal and fail the origin assertion: no timeout-only negatives.
            for headers, lines, origin in [
                (headers_a, lines_a, "gate_a"),
                (headers_b, lines_b, "gate_b"),
                (headers_a, lines_a, "gate_a_again"),
            ]:
                result = await client.post(
                    f"{urls[2]}/scoped/increment",
                    headers={**headers, "X-FluxFast-Client-ID": origin},
                    json={"key": key},
                )
                result.raise_for_status()
                with anyio.fail_after(5):
                    assert await _next_sse_payload(lines) == {
                        "protocol": "fluxfast/1",
                        "type": "invalidate",
                        "keys": [key],
                        "originClientId": origin,
                    }
        for headers, expected_owner, value in [
            (headers_a, owner, 2),
            (headers_b, other_owner, 1),
        ]:
            fresh = await client.get(f"{urls[1]}/scoped", headers=headers)
            fresh.raise_for_status()
            record = fresh.json()["resources"][key]
            assert record["value"] == {"owner": expected_owner, "value": value}
            repeated = await client.get(f"{urls[0]}/scoped", headers=headers)
            repeated.raise_for_status()
            assert repeated.json()["resources"][key] == record


@pytest.mark.anyio
async def test_http_scope_and_live_resource_forgery_cannot_cross_tenant_boundary() -> (
    None
):
    async with _gate_workers() as (client, urls, _admin, _prefix, _workers):
        headers = {
            **_FLUXFAST_HEADERS,
            "Cookie": "fixture-session=session-carol",
            "X-FluxFast-Scope": "tenant:tenant-a",
            "X-FluxFast-User": "alice",
        }
        forged_url = (
            f"{urls[1]}/scoped?tenant=tenant-a&user=alice&scope=tenant:tenant-a"
        )
        forged = await client.get(forged_url, headers=headers)
        forged.raise_for_status()
        resources = forged.json()["resources"]
        assert resources["tenant-counter"]["value"] == {"owner": "tenant-b", "value": 0}
        assert resources["user-counter"]["value"]["owner"] == "carol"
        assert "tenant-secret" not in resources
        for forged_key in [
            "tenant-secret",
            "tenant:tenant-a::tenant-counter",
            derive_live_topic(scope.tenant("tenant-a"), "tenant-counter"),
        ]:
            denied = await client.get(
                forged_url, headers={**headers, **_live_headers(forged_key, "carol")}
            )
            assert denied.status_code == 409
            assert denied.json()["error"]["type"] == "ProtocolError"
        async with client.stream(
            "GET",
            forged_url,
            headers={
                **headers,
                **_live_headers("tenant-counter,tenant-secret", "carol"),
            },
        ) as stream:
            stream.raise_for_status()
            with anyio.fail_after(5):
                assert (await _next_sse_payload(stream.aiter_lines()))["keys"] == [
                    "tenant-counter"
                ]
        unknown = await client.get(
            forged_url, headers={**headers, "X-FluxFast-Only": "tenant-secret"}
        )
        unknown.raise_for_status()
        assert unknown.json()["resources"] == {}
        for operation in ["page", "live", "mutation"]:
            if operation == "mutation":
                unauthenticated = await client.post(
                    f"{urls[0]}/scoped/increment",
                    headers=_FLUXFAST_HEADERS,
                    json={"key": "tenant-counter"},
                )
            else:
                unauthenticated = await client.get(
                    forged_url,
                    headers=_live_headers("tenant-counter")
                    if operation == "live"
                    else _FLUXFAST_HEADERS,
                )
            assert unauthenticated.status_code == 401
        # Even a mutation body alleging tenant-a still changes only carol's
        # authenticated tenant-b; the peer's cached value stays unchanged.
        result = await client.post(
            f"{urls[2]}/scoped/increment",
            headers=headers,
            json={
                "key": "tenant-counter",
                "tenant": "tenant-a",
                "scope": "tenant:tenant-a",
            },
        )
        result.raise_for_status()
        own = await client.get(forged_url, headers=headers)
        own.raise_for_status()
        assert own.json()["resources"]["tenant-counter"]["value"] == {
            "owner": "tenant-b",
            "value": 1,
        }
        peer = await client.get(
            f"{urls[0]}/scoped",
            headers={**_FLUXFAST_HEADERS, "Cookie": "fixture-session=session-alice"},
        )
        peer.raise_for_status()
        assert peer.json()["resources"]["tenant-counter"]["value"] == {
            "owner": "tenant-a",
            "value": 0,
        }


@pytest.mark.anyio
async def test_real_redis_command_and_publish_failure_recover_without_local_fallback() -> (
    None
):
    assert REDIS_URL is not None
    from redis.asyncio import Redis

    admin = Redis.from_url(REDIS_URL)
    cache_user, broker_user = f"ff_cache_{uuid4().hex}", f"ff_broker_{uuid4().hex}"
    parts = urlsplit(REDIS_URL)

    def client_url(user: str) -> str:
        return urlunsplit(
            parts._replace(netloc=f"{user}@{parts.netloc.rsplit('@', 1)[-1]}")
        )

    try:
        for user in [cache_user, broker_user]:
            await admin.execute_command(
                "ACL", "SETUSER", user, "on", "nopass", "~*", "&*", "+@all"
            )
        async with _gate_workers(
            {
                "FLUXFAST_TEST_CACHE_URL": client_url(cache_user),
                "FLUXFAST_TEST_BROKER_URL": client_url(broker_user),
            }
        ) as (client, urls, state, prefix, workers):
            first = await client.get(f"{urls[0]}/counter", headers=_FLUXFAST_HEADERS)
            first.raise_for_status()
            assert int(await state.get(f"{prefix}:loads")) == 1
            await admin.execute_command("ACL", "SETUSER", cache_user, "-exec")
            failed = await client.get(f"{urls[1]}/counter", headers=_FLUXFAST_HEADERS)
            assert failed.status_code == 500
            assert failed.json()["error"]["type"] == "ResourceCacheUnavailableError"
            assert int(await state.get(f"{prefix}:loads")) == 1
            await admin.execute_command("ACL", "SETUSER", cache_user, "+exec")
            # Drop only connections authenticated as this test's cache user.
            for connection in await admin.client_list():
                if connection.get("user") == cache_user:
                    await admin.client_kill_filter(_id=connection["id"])
            recovered = await _read_after_connection_drop(
                client, f"{urls[1]}/counter", state, f"{prefix}:loads"
            )
            assert (
                recovered.json()["resources"]["counter"]
                == first.json()["resources"]["counter"]
            )
            assert int(await state.get(f"{prefix}:loads")) == 1

            await admin.execute_command("ACL", "SETUSER", cache_user, "-eval")
            failed_mutation = await client.post(
                f"{urls[2]}/counter/increment", headers=_FLUXFAST_HEADERS
            )
            assert failed_mutation.status_code == 500
            assert int(await state.get(f"{prefix}:state")) == 2
            metrics = (await client.get(f"{urls[2]}/metrics")).json()
            assert metrics["live"]["live_invalidations_published"] == 0
            assert metrics["cache"]["cache_errors"] == 1
            await admin.execute_command("ACL", "SETUSER", cache_user, "+eval")
            recovered_mutation = await client.post(
                f"{urls[2]}/counter/increment", headers=_FLUXFAST_HEADERS
            )
            recovered_mutation.raise_for_status()

            # Canonical mutation/cache deletion succeed; broker publication is
            # independently denied by real Redis, not a Python fake.
            await admin.execute_command("ACL", "SETUSER", broker_user, "-publish")
            published_failure = await client.post(
                f"{urls[2]}/counter/increment", headers=_FLUXFAST_HEADERS
            )
            published_failure.raise_for_status()
            metrics = (await client.get(f"{urls[2]}/metrics")).json()
            assert metrics["live"]["live_publish_errors"] == 1
            # A's earlier idle cache connection was killed too; prove it can
            # recover independently when it finally requests the fresh state.
            fresh = await _read_after_connection_drop(
                client, f"{urls[0]}/counter", state, f"{prefix}:loads"
            )
            assert fresh.json()["resources"]["counter"]["value"] == {"value": 4}
            assert (
                fresh.json()["resources"]["counter"]["version"]
                != first.json()["resources"]["counter"]["version"]
            )
            await admin.execute_command("ACL", "SETUSER", broker_user, "+publish")
            async with client.stream(
                "GET", f"{urls[1]}/counter", headers=_live_headers("counter")
            ) as stream:
                stream.raise_for_status()
                lines = stream.aiter_lines()
                with anyio.fail_after(5):
                    assert (await _next_sse_payload(lines))["type"] == "ready"
                await _wait_for_worker_subscription(client, urls[1])
                for user in [cache_user, broker_user]:
                    await admin.execute_command("ACL", "SETUSER", user, "off")
                for connection in await admin.client_list():
                    if connection.get("user") in {cache_user, broker_user}:
                        await admin.client_kill_filter(_id=connection["id"])
                readiness = await client.get(f"{urls[1]}/_fluxfast/readyz")
                assert readiness.status_code == 503
                _stop_workers(workers)
                assert all(
                    process.returncode in (0, -signal.SIGTERM)
                    for _port, process in workers
                )
    finally:
        await admin.execute_command("ACL", "DELUSER", cache_user, broker_user)
        await admin.aclose()


@pytest.mark.anyio
async def test_real_workers_with_absent_redis_never_become_ready_or_run_loader() -> (
    None
):
    absent_url = f"redis://127.0.0.1:{_available_port()}/15"
    async with _gate_workers(
        {"FLUXFAST_TEST_CACHE_URL": absent_url, "FLUXFAST_TEST_BROKER_URL": absent_url}
    ) as (client, urls, admin, prefix, workers):
        for url in urls:
            assert (await client.get(f"{url}/_fluxfast/readyz")).status_code == 503
            failed = await client.get(f"{url}/counter", headers=_FLUXFAST_HEADERS)
            assert failed.status_code == 500
            assert failed.json()["error"]["type"] == "ResourceCacheUnavailableError"
        assert await admin.get(f"{prefix}:loads") is None
        _stop_workers(workers)
        assert all(
            process.returncode in (0, -signal.SIGTERM) for _port, process in workers
        )


@pytest.mark.anyio
async def test_four_fastapi_workers_share_invalidation_live_refresh_and_refill() -> (
    None
):
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
    while len(ports) < 4:
        port = _available_port()
        if port not in ports:
            ports.append(port)
    workers = [(port, _start_worker(port, environment)) for port in ports]
    assert len({process.pid for _port, process in workers}) == 4
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
            assert first.headers["X-FluxFast-Test-Worker"] == str(workers[0][1].pid)
            assert int(await admin.get(load_count_key)) == 1

            warm = await client.get(
                f"http://127.0.0.1:{ports[1]}/counter",
                headers=_FLUXFAST_HEADERS,
            )
            warm.raise_for_status()
            assert warm.json()["resources"]["counter"] == first_record
            assert warm.headers["X-FluxFast-Test-Worker"] == str(workers[1][1].pid)
            assert int(await admin.get(load_count_key)) == 1

            # D owns the live connection; it is neither loader A, warm reader B,
            # nor mutator C. Ready precedes the mutation and the refresh.
            async with client.stream(
                "GET",
                f"http://127.0.0.1:{ports[3]}/counter",
                headers=_live_headers("counter"),
            ) as stream:
                stream.raise_for_status()
                assert stream.headers["X-FluxFast-Test-Worker"] == str(
                    workers[3][1].pid
                )
                lines = stream.aiter_lines()
                with anyio.fail_after(5):
                    assert (await _next_sse_payload(lines))["type"] == "ready"
                await _wait_for_worker_subscription(
                    client, f"http://127.0.0.1:{ports[3]}"
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
                with anyio.fail_after(5):
                    assert await _next_sse_payload(lines) == {
                        "protocol": "fluxfast/1",
                        "type": "invalidate",
                        "keys": ["counter"],
                    }

            refill = await client.get(
                f"http://127.0.0.1:{ports[3]}/counter",
                headers={**_FLUXFAST_HEADERS, "X-FluxFast-Only": "counter"},
            )
            refill.raise_for_status()
            refill_record = refill.json()["resources"]["counter"]
            assert refill_record["value"] == {"value": 2}
            assert refill_record["version"] != first_record["version"]
            assert int(await admin.get(load_count_key)) == 2

            shared = await client.get(
                f"http://127.0.0.1:{ports[1]}/counter",
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
            assert cold.headers["X-FluxFast-Test-Worker"] == str(workers[0][1].pid)
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
            assert follow_up.headers["X-FluxFast-Test-Worker"] == str(workers[1][1].pid)
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


@pytest.mark.anyio
async def test_deferred_live_resource_composes_across_workers_and_expiration() -> None:
    assert REDIS_URL is not None
    from redis.asyncio import Redis

    deployment = uuid4().hex
    namespace = f"test-deferred-live-workers-{deployment}"
    state_key = f"fluxfast:test:{deployment}:activity"
    load_count_key = f"fluxfast:test:{deployment}:activity-loads"
    environment = os.environ.copy()
    environment.update(
        {
            "FLUXFAST_TEST_REDIS_URL": REDIS_URL,
            "FLUXFAST_TEST_CACHE_NAMESPACE": namespace,
            "FLUXFAST_TEST_LIVE_PREFIX": f"fluxfast:{namespace}:live:",
            "FLUXFAST_TEST_STATE_KEY": state_key,
            "FLUXFAST_TEST_LOAD_COUNT_KEY": load_count_key,
            "FLUXFAST_TEST_ACTIVITY_TTL": "1",
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
        await admin.set(state_key, 0)
        await admin.delete(load_count_key)
        async with httpx2.AsyncClient(timeout=5) as client:
            await _wait_for_workers(client, workers)
            stream_headers = {
                **_DEFERRED_LIVE_HEADERS,
                "Accept": "text/event-stream",
                "X-FluxFast-Protocol": "1",
                "X-FluxFast-Live": "1",
                "X-FluxFast-Live-Keys": "activity",
                "X-FluxFast-Client-ID": "deferred_live_test",
            }
            async with client.stream(
                "GET",
                f"http://127.0.0.1:{ports[0]}/activity",
                headers=stream_headers,
            ) as stream:
                stream.raise_for_status()
                lines = stream.aiter_lines()
                with anyio.fail_after(5):
                    ready = await _next_sse_payload(lines)
                assert ready == {
                    "protocol": "fluxfast/1",
                    "type": "ready",
                    "keys": ["activity"],
                }

                cold = await client.get(
                    f"http://127.0.0.1:{ports[1]}/activity",
                    headers=_DEFERRED_LIVE_HEADERS,
                )
                cold.raise_for_status()
                assert cold.json()["resources"] == {}
                assert cold.json()["deferred"] == ["activity"]
                assert cold.json()["live"] == ["activity"]
                assert await admin.get(load_count_key) is None

                follow_up = await client.get(
                    f"http://127.0.0.1:{ports[2]}/activity",
                    headers={
                        **_DEFERRED_LIVE_HEADERS,
                        "X-FluxFast-Only": "activity",
                    },
                )
                follow_up.raise_for_status()
                first_record = follow_up.json()["resources"]["activity"]
                assert first_record["value"] == {"value": 0}
                assert follow_up.json()["live"] == ["activity"]
                assert "deferred" not in follow_up.json()
                assert int(await admin.get(load_count_key)) == 1

                warm = await client.get(
                    f"http://127.0.0.1:{ports[0]}/activity",
                    headers=_DEFERRED_LIVE_HEADERS,
                )
                warm.raise_for_status()
                assert warm.json()["resources"]["activity"] == first_record
                assert warm.json()["live"] == ["activity"]
                assert "deferred" not in warm.json()
                assert int(await admin.get(load_count_key)) == 1

                mutation_response = await client.post(
                    f"http://127.0.0.1:{ports[2]}/activity/increment",
                    headers=_FLUXFAST_HEADERS,
                )
                mutation_response.raise_for_status()
                assert mutation_response.json()["mutation"]["invalidate"] == [
                    "activity"
                ]
                with anyio.fail_after(5):
                    invalidation = await _next_sse_payload(lines)
                assert invalidation == {
                    "protocol": "fluxfast/1",
                    "type": "invalidate",
                    "keys": ["activity"],
                }

                refreshed = await client.get(
                    f"http://127.0.0.1:{ports[1]}/activity",
                    headers={
                        **_DEFERRED_LIVE_HEADERS,
                        "X-FluxFast-Only": "activity",
                    },
                )
                refreshed.raise_for_status()
                refreshed_record = refreshed.json()["resources"]["activity"]
                assert refreshed_record["value"] == {"value": 1}
                assert refreshed_record["version"] != first_record["version"]
                assert int(await admin.get(load_count_key)) == 2

                shared_refresh = await client.get(
                    f"http://127.0.0.1:{ports[0]}/activity",
                    headers=_DEFERRED_LIVE_HEADERS,
                )
                shared_refresh.raise_for_status()
                assert (
                    shared_refresh.json()["resources"]["activity"] == refreshed_record
                )
                assert int(await admin.get(load_count_key)) == 2

                await admin.set(state_key, 2)
                await anyio.sleep(1.2)
                expired = await client.get(
                    f"http://127.0.0.1:{ports[2]}/activity",
                    headers=_DEFERRED_LIVE_HEADERS,
                )
                expired.raise_for_status()
                assert expired.json()["resources"] == {}
                assert expired.json()["deferred"] == ["activity"]
                assert int(await admin.get(load_count_key)) == 2

                reloaded = await client.get(
                    f"http://127.0.0.1:{ports[0]}/activity",
                    headers={
                        **_DEFERRED_LIVE_HEADERS,
                        "X-FluxFast-Only": "activity",
                    },
                )
                reloaded.raise_for_status()
                assert reloaded.json()["resources"]["activity"]["value"] == {"value": 2}
                assert int(await admin.get(load_count_key)) == 3
    finally:
        _stop_workers(workers)
        try:
            await cleanup_cache.clear()
            await admin.delete(state_key, load_count_key)
        finally:
            await cleanup_cache.close()
            await admin.aclose()
