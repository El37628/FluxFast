"""FastAPI application used by the repository-owned browser tests."""

import asyncio

from fastapi import FastAPI, Request
from fluxfast import (
    FluxFast,
    Page,
    append_item,
    flux_redirect,
    invalidate_resource,
    mutation,
    resource,
    scope,
)
from pydantic import BaseModel, Field

app = FastAPI()
flux = FluxFast(app)

rooms = [{"id": 1, "name": "Garden Suite"}]
activity_attempts = 0
live_analytics_generation = 0


class RoomInput(BaseModel):
    """Validated payload used to exercise browser-side form errors."""

    name: str = Field(min_length=2, max_length=80)


def application_details() -> dict[str, str]:
    return {"name": "FluxFast Browser Fixture"}


def current_rooms() -> list[dict[str, object]]:
    return [dict(room) for room in rooms]


async def slow_analytics() -> dict[str, object]:
    await asyncio.sleep(0.8)
    return {"revenue": 95_000, "period": "current month"}


async def flaky_activity() -> list[dict[str, object]]:
    global activity_attempts
    activity_attempts += 1
    await asyncio.sleep(0.2)
    if activity_attempts == 1:
        raise RuntimeError("intentional first-attempt activity failure")
    return [{"id": 1, "message": "Activity recovered after retry"}]


async def cached_analytics() -> dict[str, int]:
    await asyncio.sleep(0.6)
    return {"revenue": 101_000}


async def race_analytics() -> dict[str, int]:
    await asyncio.sleep(1.2)
    return {"revenue": 999_999}


async def live_analytics() -> dict[str, int]:
    global live_analytics_generation
    live_analytics_generation += 1
    generation = live_analytics_generation
    await asyncio.sleep(0.7)
    return {"generation": generation, "revenue": 100_000 + generation}


@flux.page("/")
async def home() -> Page:
    return Page(
        component="home/index",
        resources=[
            resource(
                "application",
                application_details,
                scope=scope.public(),
                ttl=60,
            )
        ],
    )


@flux.page("/rooms")
async def room_index() -> Page:
    return Page(
        component="rooms/index",
        resources=[
            resource(
                "application",
                application_details,
                scope=scope.public(),
                ttl=60,
            ),
            resource("rooms", current_rooms),
        ],
    )


@flux.page("/deferred")
async def deferred_index(request: Request) -> Page:
    global activity_attempts
    if request.headers.get("X-FluxFast-Only") is None:
        activity_attempts = 0

    return Page(
        component="deferred/index",
        resources=[
            resource("analytics", slow_analytics, defer=True),
            resource("activity", flaky_activity, defer=True),
        ],
    )


@flux.page("/deferred-cache")
async def deferred_cache(request: Request) -> Page:
    run_id = request.query_params.get("run", "default")
    return Page(
        component="deferred-cache/index",
        resources=[
            resource(
                "cached-analytics",
                cached_analytics,
                scope=scope.custom("browser-cache", run_id),
                ttl=60,
                defer=True,
            ),
        ],
    )


@flux.page("/deferred-race")
async def deferred_race() -> Page:
    return Page(
        component="deferred-race/index",
        resources=[
            resource("race-analytics", race_analytics, defer=True),
        ],
    )


@flux.page("/deferred-mutation")
async def deferred_mutation() -> Page:
    return Page(
        component="deferred-mutation/index",
        resources=[
            resource(
                "live-analytics",
                live_analytics,
                scope=scope.public(),
                defer=True,
            ),
        ],
    )


@flux.mutation("/rooms")
async def add_room(payload: RoomInput):
    room = {"id": len(rooms) + 1, "name": payload.name}
    rooms.append(room)
    return mutation(patch={"rooms": append_item(room)})


@flux.mutation("/rooms/finish")
async def finish_rooms():
    return flux_redirect("/")


@flux.mutation("/deferred-mutation/refresh")
async def refresh_live_analytics():
    return mutation(
        invalidates=[
            invalidate_resource("live-analytics", scope=scope.public()),
        ]
    )
