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
    replace_resource,
    resource,
    scope,
)
from pydantic import BaseModel, Field, field_validator

app = FastAPI()
flux = FluxFast(app)

rooms = [{"id": 1, "name": "Garden Suite"}]
activity_attempts = 0
live_analytics_generation = 0
live_counters: dict[tuple[str, str], int] = {}
live_notifications: dict[tuple[str, str], int] = {}
live_deferred_values: dict[tuple[str, str], int] = {}
live_patch_values: dict[tuple[str, str], int] = {}


class ApplicationDetails(BaseModel):
    """Public application metadata rendered by blocking resources."""

    name: str


class Room(BaseModel):
    """Room data shared by the index and dynamic hotel route."""

    id: int
    name: str


class HotelDetails(BaseModel):
    """Typed path-derived data for the dynamic browser route."""

    id: int
    name: str


class Analytics(BaseModel):
    """Deferred analytics payload."""

    revenue: int
    period: str


class ActivityItem(BaseModel):
    """One deferred activity entry."""

    id: int
    message: str


class RevenueAnalytics(BaseModel):
    """Minimal analytics shape used by cache and race fixtures."""

    revenue: int


class LiveAnalytics(BaseModel):
    """Versioned analytics payload refreshed by a mutation."""

    generation: int
    revenue: int


class CounterValue(BaseModel):
    """Counter payload shared by local and distributed live resources."""

    value: int


class RoomInput(BaseModel):
    """Validated payload used to exercise browser-side form errors."""

    name: str = Field(min_length=2, max_length=80)


class LiveIdentity(BaseModel):
    """Opaque identities used to isolate the browser live test scopes."""

    run: str = Field(min_length=1, max_length=80)
    tenant: str = Field(min_length=1, max_length=80)
    user: str = Field(min_length=1, max_length=80)


class User(BaseModel):
    """Application model reused outside Flux pages and resources."""

    id: int
    name: str
    email: str


class Address(BaseModel):
    """Nested input used to prove generated validation issue paths."""

    city: str = Field(min_length=2, max_length=80)
    postcode: str = Field(min_length=3, max_length=12)


class RegistrationInput(BaseModel):
    """General validation contract shared by the browser form and server."""

    name: str = Field(min_length=2, max_length=80)
    email: str = Field(min_length=5, max_length=120)
    address: Address

    @field_validator("email")
    @classmethod
    def reject_registered_email(cls, value: str) -> str:
        """Keep one authoritative server-only rule outside JSON Schema."""

        if value.casefold() == "taken@example.com":
            raise ValueError("Email is already registered")
        return value


APPLICATION = flux.define_resource("application", ApplicationDetails)
ROOMS = flux.define_resource("rooms", list[Room])
HOTEL = flux.define_resource("hotel", HotelDetails)
ANALYTICS = flux.define_resource("analytics", Analytics)
ACTIVITY = flux.define_resource("activity", list[ActivityItem])
CACHED_ANALYTICS = flux.define_resource("cached-analytics", RevenueAnalytics)
RACE_ANALYTICS = flux.define_resource("race-analytics", RevenueAnalytics)
LIVE_ANALYTICS = flux.define_resource("live-analytics", LiveAnalytics)
LIVE_COUNTER = flux.define_resource("live-counter", CounterValue)
LIVE_NOTIFICATIONS = flux.define_resource("live-notifications", CounterValue)
LIVE_DEFERRED = flux.define_resource("live-deferred", CounterValue)
LIVE_PATCHED = flux.define_resource("live-patched", CounterValue)
# This contract is consumed by the separate Redis-backed FastAPI fixture, but
# remains in the shared manifest used to generate the one browser frontend.
DISTRIBUTED_COUNTER = flux.define_resource("distributed-counter", CounterValue)
flux.define_type("RegistrationInput", RegistrationInput, mode="validation")
flux.define_type("User", User)


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


def _live_identity(request: Request) -> tuple[str, str, str]:
    return (
        request.query_params.get("run", "default"),
        request.query_params.get("tenant", "tenant-a"),
        request.query_params.get("user", "user-a"),
    )


@flux.page("/")
async def home() -> Page:
    return Page(
        component="home/index",
        resources=[
            resource(
                APPLICATION,
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
                APPLICATION,
                application_details,
                scope=scope.public(),
                ttl=60,
            ),
            resource(ROOMS, current_rooms),
        ],
    )


@flux.page("/hotels/{hotel_id}/rooms")
async def hotel_rooms(hotel_id: int) -> Page:
    return Page(
        component="hotel-rooms/index",
        resources=[
            resource(
                HOTEL,
                lambda: {"id": hotel_id, "name": f"Hotel {hotel_id}"},
            ),
            resource(ROOMS, current_rooms),
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
            resource(ANALYTICS, slow_analytics, defer=True),
            resource(ACTIVITY, flaky_activity, defer=True),
        ],
    )


@flux.page("/deferred-cache")
async def deferred_cache(request: Request) -> Page:
    run_id = request.query_params.get("run", "default")
    return Page(
        component="deferred-cache/index",
        resources=[
            resource(
                CACHED_ANALYTICS,
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
            resource(RACE_ANALYTICS, race_analytics, defer=True),
        ],
    )


@flux.page("/deferred-mutation")
async def deferred_mutation() -> Page:
    return Page(
        component="deferred-mutation/index",
        resources=[
            resource(
                LIVE_ANALYTICS,
                live_analytics,
                scope=scope.public(),
                defer=True,
            ),
        ],
    )


@flux.page("/live")
async def live_resources(request: Request) -> Page:
    run, tenant, user = _live_identity(request)
    tenant_key = (run, tenant)
    user_key = (run, user)
    tenant_scope_id = f"{run}:{tenant}"
    user_scope_id = f"{run}:{user}"
    live_counters.setdefault(tenant_key, 0)
    live_notifications.setdefault(user_key, 0)
    live_deferred_values.setdefault(tenant_key, 0)
    live_patch_values.setdefault(tenant_key, 0)

    async def counter() -> dict[str, int]:
        await asyncio.sleep(0.2)
        return {"value": live_counters[tenant_key]}

    async def notifications() -> dict[str, int]:
        await asyncio.sleep(0.1)
        return {"value": live_notifications[user_key]}

    async def deferred_live() -> dict[str, int]:
        await asyncio.sleep(0.35)
        return {"value": live_deferred_values[tenant_key]}

    async def patched_live() -> dict[str, int]:
        await asyncio.sleep(0.7)
        return {"value": live_patch_values[tenant_key]}

    return Page(
        component="live/index",
        resources=[
            resource(
                LIVE_COUNTER,
                counter,
                scope=scope.tenant(tenant_scope_id),
                ttl=60,
                live=True,
            ),
            resource(
                LIVE_NOTIFICATIONS,
                notifications,
                scope=scope.user(user_scope_id),
                ttl=60,
                live=True,
            ),
            resource(
                LIVE_DEFERRED,
                deferred_live,
                scope=scope.custom("browser-live-deferred", tenant_scope_id),
                ttl=60,
                defer=True,
                live=True,
            ),
            resource(
                LIVE_PATCHED,
                patched_live,
                scope=scope.custom("browser-live-patch", tenant_scope_id),
                ttl=60,
                live=True,
            ),
        ],
    )


@flux.mutation("/rooms")
async def add_room(payload: RoomInput):
    room = {"id": len(rooms) + 1, "name": payload.name}
    rooms.append(room)
    return mutation(patch={"rooms": append_item(room)})


@flux.mutation("/registrations")
async def register_user(payload: RegistrationInput):
    return mutation()


@flux.mutation("/rooms/finish")
async def finish_rooms():
    return flux_redirect("/")


@flux.mutation("/rooms/missing")
async def redirect_to_missing_page():
    return flux_redirect("/route-that-does-not-exist")


@flux.mutation("/deferred-mutation/refresh")
async def refresh_live_analytics():
    return mutation(
        invalidates=[
            invalidate_resource("live-analytics", scope=scope.public()),
        ]
    )


@flux.mutation("/live/counter")
async def increment_live_counter(identity: LiveIdentity):
    tenant_key = (identity.run, identity.tenant)
    tenant_scope_id = f"{identity.run}:{identity.tenant}"
    live_counters[tenant_key] = live_counters.get(tenant_key, 0) + 1
    return mutation(
        invalidates=[
            invalidate_resource("live-counter", scope=scope.tenant(tenant_scope_id)),
        ]
    )


@flux.mutation("/live/notifications")
async def increment_live_notifications(identity: LiveIdentity):
    user_key = (identity.run, identity.user)
    user_scope_id = f"{identity.run}:{identity.user}"
    live_notifications[user_key] = live_notifications.get(user_key, 0) + 1
    return mutation(
        invalidates=[
            invalidate_resource("live-notifications", scope=scope.user(user_scope_id)),
        ]
    )


@flux.mutation("/live/deferred")
async def increment_live_deferred(identity: LiveIdentity):
    tenant_key = (identity.run, identity.tenant)
    tenant_scope_id = f"{identity.run}:{identity.tenant}"
    live_deferred_values[tenant_key] = live_deferred_values.get(tenant_key, 0) + 1
    return mutation(
        invalidates=[
            invalidate_resource(
                "live-deferred",
                scope=scope.custom("browser-live-deferred", tenant_scope_id),
            ),
        ]
    )


@flux.mutation("/live/patch")
async def patch_live_resource(request: Request, identity: LiveIdentity):
    tenant_key = (identity.run, identity.tenant)
    tenant_scope_id = f"{identity.run}:{identity.tenant}"
    live_patch_values[tenant_key] = live_patch_values.get(tenant_key, 0) + 1
    value = {"value": live_patch_values[tenant_key]}
    patch = replace_resource(value)
    await flux.live.patch(
        "live-patched",
        [patch],
        scope=scope.custom("browser-live-patch", tenant_scope_id),
        origin_client_id=request.headers.get("X-FluxFast-Client-ID"),
    )
    return mutation(
        patch={"live-patched": patch},
        invalidate=["live-patched"],
    )
