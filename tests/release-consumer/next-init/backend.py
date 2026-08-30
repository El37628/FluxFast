"""Backend copied into the isolated deferred-resource consumer."""

import asyncio

from fastapi import FastAPI
from fluxfast import FluxFast, Page, resource

app = FastAPI()
flux = FluxFast(app)
analytics_loads = 0


async def load_analytics() -> dict[str, int]:
    global analytics_loads
    analytics_loads += 1
    current_load = analytics_loads
    await asyncio.sleep(1)
    return {"revenue": 120_000, "load": current_load}


@flux.page("/")
async def home() -> Page:
    return Page(
        component="home/index",
        resources=[
            resource("analytics", load_analytics, defer=True),
        ],
    )
