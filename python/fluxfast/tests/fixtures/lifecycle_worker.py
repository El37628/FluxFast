"""A real two-worker Uvicorn application with observable owned cleanup."""

from __future__ import annotations

import asyncio
import json
import os
from contextlib import asynccontextmanager, suppress
from pathlib import Path

from fastapi import FastAPI

from fluxfast import FluxFast, MemoryLiveBroker, MemoryResourceCache

directory = Path(os.environ["FLUXFAST_TEST_LIFECYCLE_DIRECTORY"])


def record(phase: str) -> None:
    marker = directory / f"{os.getpid()}-{phase}.json"
    temporary_marker = marker.with_suffix(".tmp")
    temporary_marker.write_text(json.dumps({"pid": os.getpid(), "phase": phase}))
    temporary_marker.replace(marker)


class Cache(MemoryResourceCache):
    async def close(self) -> None:
        record("cache-close")


class Broker(MemoryLiveBroker):
    async def close(self) -> None:
        await super().close()
        record("broker-close")


broker = Broker()


async def consume() -> None:
    async for _ in broker.subscribe({"lifecycle-worker"}):
        pass


@asynccontextmanager
async def lifespan(app: FastAPI):
    task = asyncio.create_task(consume())
    while broker.subscriber_count != 1:
        await asyncio.sleep(0)
    record("startup")
    try:
        yield
    finally:
        task.cancel()
        with suppress(asyncio.CancelledError):
            await task
        record("application-shutdown")


app = FastAPI(lifespan=lifespan)
flux = FluxFast(app, cache=Cache(), broker=broker)
