"""Redis-backed FastAPI fixture used by the distributed browser test."""

import asyncio
import json
import os
import secrets
from contextlib import suppress

from fastapi import FastAPI, HTTPException, Request, Response
from fluxfast import (
    FluxFast,
    Page,
    RedisLiveBroker,
    RedisResourceCache,
    derive_live_topic,
    invalidate_resource,
    mutation,
    resource,
    scope,
)
from pydantic import BaseModel, Field
from redis.asyncio import Redis


def _required_environment(name: str) -> str:
    value = os.getenv(name)
    if not value:
        raise RuntimeError(f"{name} is required by the distributed browser fixture")
    return value


REDIS_URL = os.getenv("FLUXFAST_TEST_REDIS_URL") or _required_environment("REDIS_URL")
CACHE_NAMESPACE = os.getenv("FLUXFAST_TEST_CACHE_NAMESPACE", "fluxfast-compose")
LIVE_PREFIX = os.getenv(
    "FLUXFAST_TEST_LIVE_PREFIX",
    "fluxfast:compose:live:",
)
DIAGNOSTIC_PREFIX = os.getenv(
    "FLUXFAST_TEST_DIAGNOSTIC_PREFIX",
    "fluxfast:compose:diagnostics",
)
WORKER_NAME = os.getenv("FLUXFAST_TEST_WORKER_NAME", "production")

app = FastAPI()
state = Redis.from_url(REDIS_URL)
cache = RedisResourceCache.from_url(REDIS_URL, namespace=CACHE_NAMESPACE)
flux = FluxFast(
    app,
    cache=cache,
    broker=RedisLiveBroker.from_url(
        REDIS_URL,
        channel_prefix=LIVE_PREFIX,
        client_name=f"{DIAGNOSTIC_PREFIX}:broker:{os.getpid()}",
    ),
)
worker_command_task: asyncio.Task[None] | None = None


class DistributedIdentity(BaseModel):
    """Test-run identity sent by the distributed browser fixture."""

    run: str = Field(min_length=1, max_length=80)
    client: str = Field(pattern="^[ab]$")


class CounterValue(BaseModel):
    """Typed value shared by every distributed worker."""

    value: int


DISTRIBUTED_COUNTER = flux.define_resource("distributed-counter", CounterValue)

_SCOPED_SESSIONS = {
    "session-alice": ("alice", "tenant-a"),
    "session-bob": ("bob", "tenant-a"),
    "session-carol": ("carol", "tenant-b"),
}


class ScopedMutation(BaseModel):
    run: str = Field(min_length=1, max_length=80)
    key: str = Field(pattern="^scoped-(user|tenant)$")


def _scoped_identity(request: Request) -> tuple[str, str]:
    identity = _SCOPED_SESSIONS.get(request.cookies.get("fixture-session", ""))
    if identity is None:
        raise HTTPException(status_code=401)
    return identity


def _scoped_value_key(run: str, kind: str, identity: str) -> str:
    return f"{DIAGNOSTIC_PREFIX}:{run}:scoped:{kind}:{identity}"


@flux.page("/distributed-scoped")
async def distributed_scoped(request: Request) -> Page:
    user, tenant = _scoped_identity(request)
    run = request.query_params.get("run", "default")

    def loader(kind: str, identity: str):
        async def load() -> dict[str, str | int]:
            key = _scoped_value_key(run, kind, identity)
            await state.set(key, 0, ex=300, nx=True)
            return {"owner": identity, "value": int(await state.get(key))}

        return load

    specs = [
        resource(
            "scoped-user",
            loader("user", user),
            scope=scope.user(f"{run}:{user}"),
            ttl=60,
            live=True,
        ),
        resource(
            "scoped-tenant",
            loader("tenant", tenant),
            scope=scope.tenant(f"{run}:{tenant}"),
            ttl=60,
            live=True,
        ),
    ]
    if tenant == "tenant-a":
        specs.append(
            resource(
                "scoped-secret",
                lambda: "tenant-a only",
                scope=scope.tenant(f"{run}:{tenant}"),
                ttl=60,
                live=True,
            )
        )
    return Page("distributed-live/index", specs)


@flux.mutation("/distributed-scoped/increment")
async def scoped_increment(request: Request, command: ScopedMutation):
    user, tenant = _scoped_identity(request)
    if command.key == "scoped-user":
        kind, identity, resource_scope = (
            "user",
            user,
            scope.user(f"{command.run}:{user}"),
        )
    else:
        kind, identity, resource_scope = (
            "tenant",
            tenant,
            scope.tenant(f"{command.run}:{tenant}"),
        )
    await state.incr(_scoped_value_key(command.run, kind, identity))
    return mutation(invalidate=[invalidate_resource(command.key, scope=resource_scope)])


def _state_key(run: str) -> str:
    return f"{DIAGNOSTIC_PREFIX}:{run}:state"


def _record_key(run: str, role: str) -> str:
    return f"{DIAGNOSTIC_PREFIX}:{run}:role:{role}"


def _claim_key(run: str, role: str) -> str:
    return f"{DIAGNOSTIC_PREFIX}:{run}:claim:{role}"


def _calls_key(run: str, role: str) -> str:
    return f"{DIAGNOSTIC_PREFIX}:{run}:calls:{role}"


def _mutation_key(run: str) -> str:
    return f"{DIAGNOSTIC_PREFIX}:{run}:mutation"


def _mutation_ack_key(run: str) -> str:
    return f"{DIAGNOSTIC_PREFIX}:{run}:mutation-ack"


def _workers_key() -> str:
    return f"{DIAGNOSTIC_PREFIX}:workers"


def _worker_queue_key(identity: str) -> str:
    return f"{DIAGNOSTIC_PREFIX}:worker-queue:{identity}"


def _worker_identity() -> str:
    return f"{WORKER_NAME}:{os.getpid()}"


async def _record(run: str, role: str) -> None:
    key = _record_key(run, role)
    await state.sadd(key, _worker_identity())
    await state.expire(key, 300)
    calls_key = _calls_key(run, role)
    await state.incr(calls_key)
    await state.expire(calls_key, 300)


async def _claim_distinct_worker(run: str, role: str) -> bool:
    """Try to claim one worker distinct from the initial loading worker."""

    identity = _worker_identity()
    loader_workers = {
        value.decode() for value in await state.smembers(_record_key(run, "loader:a"))
    }
    if identity in loader_workers:
        return False

    claim_key = _claim_key(run, role)
    claimed = await state.get(claim_key)
    if claimed is None:
        if await state.set(claim_key, identity, ex=300, nx=True):
            claimed_identity = identity
        else:
            claimed = await state.get(claim_key)
            claimed_identity = claimed.decode() if claimed is not None else ""
    else:
        claimed_identity = claimed.decode()
    if claimed_identity == identity:
        await _record(run, f"claim:{role}")
        return True
    return False


async def _worker_commands() -> None:
    """Execute deterministic production-test mutations in this worker."""

    identity = _worker_identity()
    queue = _worker_queue_key(identity)
    while True:
        item = await state.blpop(queue, timeout=1)
        if item is None:
            continue
        _, raw_command = item
        command = json.loads(raw_command)
        run = command["run"]
        operation = command["operation"]
        accepted = await state.set(
            _mutation_key(run),
            identity,
            ex=300,
            nx=True,
        )
        if accepted:
            await state.incr(_state_key(run))
            await _record(run, "mutation")
            await flux.live.invalidate(
                "distributed-counter",
                scope=scope.custom("browser-distributed", run),
            )
        await state.set(
            _mutation_ack_key(run),
            f"{operation}:{identity}",
            ex=300,
        )


async def _start_worker_commands() -> None:
    global worker_command_task
    identity = _worker_identity()
    await state.sadd(_workers_key(), identity)
    await state.expire(_workers_key(), 300)
    worker_command_task = asyncio.create_task(_worker_commands())


async def _stop_worker_commands() -> None:
    global worker_command_task
    if worker_command_task is not None:
        worker_command_task.cancel()
        with suppress(asyncio.CancelledError):
            await worker_command_task
        worker_command_task = None
    await state.srem(_workers_key(), _worker_identity())


@app.middleware("http")
async def identify_worker(request, call_next):
    response = await call_next(request)
    response.headers["X-FluxFast-Test-Worker"] = _worker_identity()
    rotate_worker_connection = (
        request.url.path == "/distributed-live"
        and request.query_params.get("claim") == "1"
    )
    if rotate_worker_connection:
        # Browser B needs fresh private connections to claim a worker distinct
        # from the initial loader. Next strips this hop-by-hop header from the
        # public response.
        response.headers["Connection"] = "close"
    return response


@app.get("/health")
async def health(response: Response) -> dict[str, str | int]:
    return {"worker": WORKER_NAME, "pid": os.getpid()}


@flux.page("/distributed-live")
async def distributed_live(request: Request) -> Page:
    run = request.query_params.get("run", "default")
    client = request.query_params.get("client", "a")
    claimed = False
    if request.query_params.get("claim") == "1":
        claimed = await _claim_distinct_worker(run, client)
    if request.headers.get("X-FluxFast-Live") == "1":
        role = f"stream:{client}"
    elif request.headers.get("X-FluxFast-Only"):
        role = f"refresh:{client}"
    else:
        role = f"page:{client}"
    await _record(run, role)

    async def load_counter() -> dict[str, int]:
        await _record(run, f"loader:{client}")
        key = _state_key(run)
        await state.set(key, 0, nx=True)
        await state.expire(key, 300)
        raw_value = await state.get(key)
        if raw_value is None:
            raise RuntimeError("distributed browser state is missing")
        return {"value": int(raw_value)}

    return Page(
        "distributed-live/index",
        [
            resource(
                DISTRIBUTED_COUNTER,
                load_counter,
                scope=scope.custom("browser-distributed", run),
                ttl=60,
                live=True,
            )
        ],
        meta={"worker": _worker_identity(), "claimed": claimed},
    )


@flux.mutation("/distributed-live/increment")
async def increment_counter(identity: DistributedIdentity):
    current_worker = _worker_identity()
    reserved_workers = {
        value.decode()
        for value in await state.smembers(_record_key(identity.run, "loader:a"))
    }
    claimed = await state.get(_claim_key(identity.run, "b"))
    if claimed is None:
        accepted = await state.set(
            _mutation_key(identity.run),
            current_worker,
            ex=300,
            nx=True,
        )
        if not accepted:
            return mutation()
        await _record(identity.run, "mutation")
        await state.incr(_state_key(identity.run))
        return mutation(
            invalidates=[
                invalidate_resource(
                    "distributed-counter",
                    scope=scope.custom("browser-distributed", identity.run),
                )
            ]
        )

    reserved_workers.add(claimed.decode())
    registered_workers = {
        value.decode() for value in await state.smembers(_workers_key())
    }
    targets = registered_workers - reserved_workers
    if len(registered_workers) != 3 or len(targets) != 1:
        raise RuntimeError("distributed production worker assignment is incomplete")

    target = targets.pop()
    operation = secrets.token_hex(8)
    await state.delete(_mutation_ack_key(identity.run))
    await state.rpush(
        _worker_queue_key(target),
        json.dumps({"run": identity.run, "operation": operation}),
    )
    expected_ack = f"{operation}:{target}"
    for _ in range(200):
        raw_ack = await state.get(_mutation_ack_key(identity.run))
        if raw_ack is not None and raw_ack.decode() == expected_ack:
            return mutation()
        await asyncio.sleep(0.01)
    raise RuntimeError("target FastAPI worker did not acknowledge the mutation")


_DIAGNOSTIC_ROLES = (
    "page:a",
    "page:b",
    "stream:a",
    "stream:b",
    "refresh:a",
    "refresh:b",
    "loader:a",
    "loader:b",
    "claim:b",
    "mutation",
)


@app.get("/distributed-live/diagnostics")
async def diagnostics(run: str) -> dict[str, object]:
    records: dict[str, list[str]] = {}
    calls: dict[str, int] = {}
    for role in _DIAGNOSTIC_ROLES:
        values = await state.smembers(_record_key(run, role))
        records[role] = sorted(value.decode() for value in values)
        calls[role] = int(await state.get(_calls_key(run, role)) or 0)
    raw_value = await state.get(_state_key(run))
    # Observe real Redis subscribe ACKs, rather than treating the asynchronously
    # emitted SSE ready frame as proof the broker has established every topic.
    expected = {}
    for user, tenant in _SCOPED_SESSIONS.values():
        user_topic = LIVE_PREFIX + derive_live_topic(
            scope.user(f"{run}:{user}"), "scoped-user"
        )
        tenant_topic = LIVE_PREFIX + derive_live_topic(
            scope.tenant(f"{run}:{tenant}"), "scoped-tenant"
        )
        expected[user_topic] = 1
        expected[tenant_topic] = expected.get(tenant_topic, 0) + 1
    actual = {
        channel.decode(): count
        for channel, count in await state.pubsub_numsub(*expected)
    }
    return {
        "records": records,
        "calls": calls,
        "scopedReady": actual == expected,
        "state": None if raw_value is None else int(raw_value),
        "workers": sorted(
            value.decode() for value in await state.smembers(_workers_key())
        ),
    }


@app.post("/distributed-live/disconnect")
async def disconnect_after_missed_update(run: str) -> dict[str, int]:
    """Miss a signal, then drop only this isolated fixture's Pub/Sub clients."""

    await state.incr(_state_key(run))
    await cache.delete(
        f"{scope.custom('browser-distributed', run).fingerprint()}::distributed-counter"
    )
    disconnected = 0
    for client in await state.client_list():
        if client.get("name", "").startswith(
            f"{DIAGNOSTIC_PREFIX}:broker:"
        ) and "P" in client.get("flags", ""):
            disconnected += await state.client_kill_filter(_id=client["id"])
    return {"disconnected": disconnected}


@app.delete("/distributed-live/diagnostics")
async def clear_diagnostics(run: str) -> dict[str, bool]:
    keys = [
        _state_key(run),
        _claim_key(run, "b"),
        _mutation_key(run),
        _mutation_ack_key(run),
    ]
    keys.extend(_record_key(run, role) for role in _DIAGNOSTIC_ROLES)
    keys.extend(_calls_key(run, role) for role in _DIAGNOSTIC_ROLES)
    for user, tenant in _SCOPED_SESSIONS.values():
        keys.extend(
            [
                _scoped_value_key(run, "user", user),
                _scoped_value_key(run, "tenant", tenant),
            ]
        )
        for key, resource_scope in [
            ("scoped-user", scope.user(f"{run}:{user}")),
            ("scoped-tenant", scope.tenant(f"{run}:{tenant}")),
            ("scoped-secret", scope.tenant(f"{run}:{tenant}")),
        ]:
            await cache.delete(f"{resource_scope.fingerprint()}::{key}")
    await state.delete(*keys)
    await cache.delete(
        f"{scope.custom('browser-distributed', run).fingerprint()}::distributed-counter"
    )
    return {"cleared": True}


app.router.add_event_handler("startup", _start_worker_commands)
app.router.add_event_handler("shutdown", _stop_worker_commands)
app.router.add_event_handler("shutdown", state.aclose)
