"""Redis-backed FastAPI fixture used by the distributed browser test."""

import os

from fastapi import FastAPI, Request, Response
from fluxfast import (
    FluxFast,
    Page,
    RedisLiveBroker,
    RedisResourceCache,
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


REDIS_URL = _required_environment("FLUXFAST_TEST_REDIS_URL")
CACHE_NAMESPACE = _required_environment("FLUXFAST_TEST_CACHE_NAMESPACE")
LIVE_PREFIX = _required_environment("FLUXFAST_TEST_LIVE_PREFIX")
DIAGNOSTIC_PREFIX = _required_environment("FLUXFAST_TEST_DIAGNOSTIC_PREFIX")
WORKER_NAME = _required_environment("FLUXFAST_TEST_WORKER_NAME")

app = FastAPI()
state = Redis.from_url(REDIS_URL)
cache = RedisResourceCache.from_url(REDIS_URL, namespace=CACHE_NAMESPACE)
flux = FluxFast(
    app,
    cache=cache,
    broker=RedisLiveBroker.from_url(
        REDIS_URL,
        channel_prefix=LIVE_PREFIX,
    ),
)


class DistributedIdentity(BaseModel):
    """Test-run identity sent by the distributed browser fixture."""

    run: str = Field(min_length=1, max_length=80)
    client: str = Field(pattern="^[ab]$")


def _state_key(run: str) -> str:
    return f"{DIAGNOSTIC_PREFIX}:{run}:state"


def _record_key(run: str, role: str) -> str:
    return f"{DIAGNOSTIC_PREFIX}:{run}:role:{role}"


async def _record(run: str, role: str) -> None:
    key = _record_key(run, role)
    await state.sadd(key, f"{WORKER_NAME}:{os.getpid()}")
    await state.expire(key, 300)


@app.middleware("http")
async def identify_worker(request, call_next):
    response = await call_next(request)
    response.headers["X-FluxFast-Test-Worker"] = (
        f"{WORKER_NAME}:{os.getpid()}"
    )
    return response


@app.get("/health")
async def health(response: Response) -> dict[str, str | int]:
    return {"worker": WORKER_NAME, "pid": os.getpid()}


@flux.page("/distributed-live")
async def distributed_live(request: Request) -> Page:
    run = request.query_params.get("run", "default")
    client = request.query_params.get("client", "a")
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
                "distributed-counter",
                load_counter,
                scope=scope.custom("browser-distributed", run),
                ttl=60,
                live=True,
            )
        ],
    )


@flux.mutation("/distributed-live/increment")
async def increment_counter(identity: DistributedIdentity):
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


_DIAGNOSTIC_ROLES = (
    "page:a",
    "page:b",
    "stream:a",
    "stream:b",
    "refresh:a",
    "refresh:b",
    "loader:a",
    "loader:b",
    "mutation",
)


@app.get("/distributed-live/diagnostics")
async def diagnostics(run: str) -> dict[str, object]:
    records: dict[str, list[str]] = {}
    for role in _DIAGNOSTIC_ROLES:
        values = await state.smembers(_record_key(run, role))
        records[role] = sorted(value.decode() for value in values)
    raw_value = await state.get(_state_key(run))
    return {
        "records": records,
        "state": None if raw_value is None else int(raw_value),
    }


@app.delete("/distributed-live/diagnostics")
async def clear_diagnostics(run: str) -> dict[str, bool]:
    keys = [_state_key(run)]
    keys.extend(_record_key(run, role) for role in _DIAGNOSTIC_ROLES)
    await state.delete(*keys)
    await cache.delete(
        f'{scope.custom("browser-distributed", run).fingerprint()}'
        "::distributed-counter"
    )
    return {"cleared": True}


app.router.add_event_handler("shutdown", state.aclose)
