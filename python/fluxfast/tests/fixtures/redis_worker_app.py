"""Process-isolated FastAPI fixture for shared Redis cache integration tests."""

from __future__ import annotations

import os

from fastapi import FastAPI, Response
from redis.asyncio import Redis

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


def _required_environment(name: str) -> str:
    value = os.getenv(name)
    if not value:
        raise RuntimeError(f"{name} is required by the Redis worker fixture")
    return value


REDIS_URL = _required_environment("FLUXFAST_TEST_REDIS_URL")
CACHE_NAMESPACE = _required_environment("FLUXFAST_TEST_CACHE_NAMESPACE")
LIVE_PREFIX = _required_environment("FLUXFAST_TEST_LIVE_PREFIX")
STATE_KEY = _required_environment("FLUXFAST_TEST_STATE_KEY")
LOAD_COUNT_KEY = _required_environment("FLUXFAST_TEST_LOAD_COUNT_KEY")

app = FastAPI()
state = Redis.from_url(REDIS_URL)
cache = RedisResourceCache.from_url(
    REDIS_URL,
    namespace=CACHE_NAMESPACE,
)
flux = FluxFast(
    app,
    cache=cache,
    broker=RedisLiveBroker.from_url(
        REDIS_URL,
        channel_prefix=LIVE_PREFIX,
    ),
)


@app.middleware("http")
async def identify_worker(request, call_next):
    response = await call_next(request)
    response.headers["X-FluxFast-Test-Worker"] = str(os.getpid())
    return response


@app.get("/health")
async def health(response: Response) -> dict[str, int]:
    response.headers["X-FluxFast-Test-Worker"] = str(os.getpid())
    return {"pid": os.getpid()}


async def load_counter() -> dict[str, int]:
    await state.incr(LOAD_COUNT_KEY)
    raw_value = await state.get(STATE_KEY)
    if raw_value is None:
        raise RuntimeError("canonical counter state is missing")
    return {"value": int(raw_value)}


@flux.page("/counter")
async def counter_page() -> Page:
    return Page(
        "counter/index",
        [
            resource(
                "counter",
                load_counter,
                scope=scope.public(),
                ttl=60,
                live=True,
            )
        ],
    )


@flux.mutation("/counter/increment", methods=["POST"])
async def increment_counter():
    await state.incr(STATE_KEY)
    return mutation(
        invalidate=[invalidate_resource("counter", scope=scope.public())]
    )


app.router.add_event_handler("shutdown", state.aclose)
