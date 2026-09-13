"""Process-isolated FastAPI fixture for shared Redis cache integration tests."""

from __future__ import annotations

import os

from fastapi import FastAPI, HTTPException, Request, Response
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
ACTIVITY_TTL = float(os.getenv("FLUXFAST_TEST_ACTIVITY_TTL", "30"))

app = FastAPI()
state = Redis.from_url(REDIS_URL)
cache = RedisResourceCache.from_url(
    os.getenv("FLUXFAST_TEST_CACHE_URL", REDIS_URL),
    namespace=CACHE_NAMESPACE,
)
flux = FluxFast(
    app,
    cache=cache,
    broker=RedisLiveBroker.from_url(
        os.getenv("FLUXFAST_TEST_BROKER_URL", REDIS_URL),
        channel_prefix=LIVE_PREFIX,
        client_name=f"{CACHE_NAMESPACE}-broker-{os.getpid()}",
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


@app.get("/metrics")
async def metrics() -> dict[str, object]:
    return {
        "cache": cache.metrics.snapshot().as_dict(),
        "live": flux.live.metrics.snapshot().as_dict(),
        "subscribers": flux.live.broker.subscriber_count,
    }


# These opaque fixture sessions deliberately map to server-owned identities.
# Query parameters, resource names, and alleged scope headers never select them.
_SESSIONS = {
    "session-alice": ("alice", "tenant-a"),
    "session-bob": ("bob", "tenant-a"),
    "session-carol": ("carol", "tenant-b"),
}


def _identity(request: Request) -> tuple[str, str]:
    identity = _SESSIONS.get(request.cookies.get("fixture-session", ""))
    if identity is None:
        raise HTTPException(status_code=401)
    return identity


def _scoped_key(kind: str, identity: str) -> str:
    return f"{STATE_KEY}:{kind}:{identity}"


@flux.page("/scoped")
async def scoped_page(request: Request) -> Page:
    user, tenant = _identity(request)

    def scoped_loader(kind: str, identity: str):
        async def load() -> dict[str, object]:
            await state.incr(f"{LOAD_COUNT_KEY}:{kind}:{identity}")
            key = _scoped_key(kind, identity)
            await state.set(key, 0, nx=True)
            return {"owner": identity, "value": int(await state.get(key))}

        return load

    resources = [
        resource(
            "user-counter",
            scoped_loader("user", user),
            scope=scope.user(user),
            ttl=60,
            live=True,
        ),
        resource(
            "tenant-counter",
            scoped_loader("tenant", tenant),
            scope=scope.tenant(tenant),
            ttl=60,
            live=True,
        ),
    ]
    if tenant == "tenant-a":
        resources.append(
            resource(
                "tenant-secret",
                lambda: "only tenant-a",
                scope=scope.tenant(tenant),
                ttl=60,
                live=True,
            )
        )
    return Page("scoped/index", resources)


@flux.mutation("/scoped/increment", methods=["POST"])
async def scoped_increment(request: Request):
    user, tenant = _identity(request)
    payload = await request.json()
    key = payload.get("key")
    if key == "user-counter":
        kind, identity, resource_scope = "user", user, scope.user(user)
    elif key == "tenant-counter":
        kind, identity, resource_scope = "tenant", tenant, scope.tenant(tenant)
    else:
        raise HTTPException(status_code=400)
    await state.incr(_scoped_key(kind, identity))
    return mutation(invalidate=[invalidate_resource(key, scope=resource_scope)])


async def load_counter() -> dict[str, int]:
    await state.incr(LOAD_COUNT_KEY)
    raw_value = await state.get(STATE_KEY)
    if raw_value is None:
        raise RuntimeError("canonical counter state is missing")
    return {"value": int(raw_value)}


async def load_analytics() -> dict[str, int]:
    await state.incr(LOAD_COUNT_KEY)
    raw_value = await state.get(STATE_KEY)
    if raw_value is None:
        raise RuntimeError("canonical analytics state is missing")
    return {"visits": int(raw_value)}


async def load_activity() -> dict[str, int]:
    await state.incr(LOAD_COUNT_KEY)
    raw_value = await state.get(STATE_KEY)
    if raw_value is None:
        raise RuntimeError("canonical activity state is missing")
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


@flux.page("/analytics")
async def analytics_page() -> Page:
    return Page(
        "analytics/index",
        [
            resource(
                "analytics",
                load_analytics,
                scope=scope.tenant("org-1"),
                ttl=60,
                defer=True,
            )
        ],
    )


@flux.page("/activity")
async def activity_page() -> Page:
    return Page(
        "activity/index",
        [
            resource(
                "activity",
                load_activity,
                scope=scope.tenant("org-1"),
                ttl=ACTIVITY_TTL,
                defer=True,
                live=True,
            )
        ],
    )


@flux.mutation("/counter/increment", methods=["POST"])
async def increment_counter():
    await state.incr(STATE_KEY)
    return mutation(invalidate=[invalidate_resource("counter", scope=scope.public())])


@flux.mutation("/activity/increment", methods=["POST"])
async def increment_activity():
    await state.incr(STATE_KEY)
    return mutation(
        invalidate=[invalidate_resource("activity", scope=scope.tenant("org-1"))]
    )


app.router.add_event_handler("shutdown", state.aclose)
