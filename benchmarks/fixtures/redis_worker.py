"""Process-isolated FastAPI fixture for distributed cache benchmarks."""

from __future__ import annotations

import asyncio
import os

from fastapi import FastAPI, Response
from fluxfast import (
    FluxFast,
    Page,
    RedisCacheMetrics,
    RedisResourceCache,
    resource,
    scope,
)
from redis.asyncio import Redis


def _required_environment(name: str) -> str:
    value = os.getenv(name)
    if not value:
        raise RuntimeError(f"{name} is required by the Redis benchmark fixture")
    return value


REDIS_URL = _required_environment("FLUXFAST_BENCHMARK_REDIS_URL")
CACHE_NAMESPACE = _required_environment("FLUXFAST_BENCHMARK_CACHE_NAMESPACE")
STATE_KEY = _required_environment("FLUXFAST_BENCHMARK_STATE_KEY")
LOAD_COUNT_KEY = _required_environment("FLUXFAST_BENCHMARK_LOAD_COUNT_KEY")
LOADER_DELAY_SECONDS = float(
    os.getenv("FLUXFAST_BENCHMARK_LOADER_DELAY_SECONDS", "0.05")
)

app = FastAPI()
state = Redis.from_url(REDIS_URL)
metrics = RedisCacheMetrics()
cache = RedisResourceCache.from_url(
    REDIS_URL,
    namespace=CACHE_NAMESPACE,
    metrics=metrics,
)
flux = FluxFast(app, cache=cache)


@app.middleware("http")
async def identify_worker(request, call_next):
    response = await call_next(request)
    response.headers["X-FluxFast-Benchmark-Worker"] = str(os.getpid())
    return response


@app.get("/health")
async def health(response: Response) -> dict[str, int]:
    response.headers["X-FluxFast-Benchmark-Worker"] = str(os.getpid())
    return {"pid": os.getpid()}


@app.get("/metrics")
async def cache_metrics() -> dict[str, object]:
    return {"pid": os.getpid(), "metrics": metrics.snapshot().as_dict()}


async def load_benchmark_resource() -> dict[str, int]:
    await state.incr(LOAD_COUNT_KEY)
    await asyncio.sleep(LOADER_DELAY_SECONDS)
    value = await state.get(STATE_KEY)
    if value is None:
        raise RuntimeError("benchmark canonical state is missing")
    return {"value": int(value)}


@flux.page("/resource")
async def benchmark_page() -> Page:
    return Page(
        "benchmark/index",
        [
            resource(
                "benchmark",
                load_benchmark_resource,
                scope=scope.public(),
                ttl=60,
            )
        ],
    )


app.router.add_event_handler("shutdown", state.aclose)
