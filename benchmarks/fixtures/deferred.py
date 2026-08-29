"""Controlled blocking and deferred resource benchmark application."""

from collections.abc import Callable

import anyio
from fastapi import FastAPI
from fluxfast import FluxFast, Page, resource

RESOURCE_DELAYS_SECONDS = {
    "fast": 0.01,
    "medium": 0.10,
    "slow": 0.50,
}


def create_deferred_benchmark_app() -> tuple[FastAPI, dict[str, int]]:
    """Create a fresh app and observable loader counters for one benchmark run."""
    app = FastAPI()
    flux = FluxFast(app)
    loader_counts = {
        f"{mode}:{key}": 0
        for mode in ("blocking", "deferred")
        for key in RESOURCE_DELAYS_SECONDS
    }

    def loader(mode: str, key: str) -> Callable[[], object]:
        async def load() -> dict[str, object]:
            loader_counts[f"{mode}:{key}"] += 1
            await anyio.sleep(RESOURCE_DELAYS_SECONDS[key])
            return {
                "resource": key,
                "delayMs": round(RESOURCE_DELAYS_SECONDS[key] * 1_000),
                "payload": key * 64,
            }

        return load

    @flux.page("/blocking")
    async def blocking_page() -> Page:
        return Page(
            "benchmark/blocking",
            resources=[
                resource(key, loader("blocking", key))
                for key in RESOURCE_DELAYS_SECONDS
            ],
        )

    @flux.page("/deferred")
    async def deferred_page() -> Page:
        return Page(
            "benchmark/deferred",
            resources=[
                resource("fast", loader("deferred", "fast")),
                resource(
                    "medium",
                    loader("deferred", "medium"),
                    defer=True,
                ),
                resource(
                    "slow",
                    loader("deferred", "slow"),
                    defer=True,
                ),
            ],
        )

    return app, loader_counts
