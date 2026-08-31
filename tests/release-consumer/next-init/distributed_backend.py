"""Redis-backed backend copied into the isolated release consumer."""

import asyncio
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
        raise RuntimeError(f"{name} is required by the distributed consumer")
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
    broker=RedisLiveBroker.from_url(REDIS_URL, channel_prefix=LIVE_PREFIX),
)


class DistributedIdentity(BaseModel):
    """Identity sent by the clean distributed consumer."""

    run: str = Field(min_length=1, max_length=80)
    client: str = Field(pattern="^[abc]$")


def _state_key(run: str) -> str:
    return f"{DIAGNOSTIC_PREFIX}:{run}:state"


def _record_key(run: str, role: str) -> str:
    return f"{DIAGNOSTIC_PREFIX}:{run}:role:{role}"


async def _record(run: str, role: str) -> None:
    key = _record_key(run, role)
    await state.sadd(key, f"{WORKER_NAME}:{os.getpid()}")
    await state.expire(key, 300)


@app.middleware("http")
async def identify_worker(request: Request, call_next):
    response = await call_next(request)
    response.headers["X-FluxFast-Test-Worker"] = f"{WORKER_NAME}:{os.getpid()}"
    return response


@app.get("/health")
async def health(response: Response) -> dict[str, str | int]:
    return {"worker": WORKER_NAME, "pid": os.getpid()}


@flux.page("/")
async def home(request: Request) -> Page:
    run = request.query_params.get("run", "default")
    client = request.query_params.get("client", "a")
    if request.headers.get("X-FluxFast-Live") == "1":
        role = f"stream:{client}"
    elif request.headers.get("X-FluxFast-Only"):
        role = f"refresh:{client}"
    else:
        role = f"page:{client}"
    await _record(run, role)

    async def load_counter() -> dict[str, int | str]:
        await _record(run, f"loader:{client}")
        key = _state_key(run)
        await state.set(key, 0, nx=True)
        await state.expire(key, 300)
        await asyncio.sleep(1)
        raw_value = await state.get(key)
        if raw_value is None:
            raise RuntimeError("distributed consumer state is missing")
        return {"value": int(raw_value), "loadedBy": WORKER_NAME}

    return Page(
        component="home/index",
        resources=[
            resource(
                "distributed-counter",
                load_counter,
                scope=scope.tenant(run),
                ttl=60,
                defer=True,
                live=True,
            )
        ],
    )


@flux.mutation("/increment")
async def increment(identity: DistributedIdentity):
    await _record(identity.run, "mutation")
    await state.incr(_state_key(identity.run))
    return mutation(
        invalidates=[
            invalidate_resource(
                "distributed-counter",
                scope=scope.tenant(identity.run),
            )
        ]
    )


_DIAGNOSTIC_ROLES = tuple(
    f"{role}:{client}"
    for role in ("page", "stream", "refresh", "loader")
    for client in ("a", "b", "c")
) + ("mutation",)


@app.get("/diagnostics")
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


@app.delete("/diagnostics")
async def clear_diagnostics(run: str) -> dict[str, bool]:
    keys = [_state_key(run)]
    keys.extend(_record_key(run, role) for role in _DIAGNOSTIC_ROLES)
    await state.delete(*keys)
    await cache.clear()
    return {"cleared": True}


app.router.add_event_handler("shutdown", state.aclose)
