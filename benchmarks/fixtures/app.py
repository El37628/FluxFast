"""Controlled same-process application used by the benchmark script."""

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from fluxfast import FluxFast, Page, resource, scope


def create_benchmark_app() -> tuple[FastAPI, dict[str, int]]:
    app = FastAPI()
    flux = FluxFast(app)
    counts: dict[str, int] = {}

    rooms = [
        {
            "id": room_id,
            "number": str(100 + room_id),
            "type": "suite" if room_id % 5 == 0 else "standard",
            "status": "occupied" if room_id % 3 == 0 else "available",
        }
        for room_id in range(1, 1_001)
    ]
    guests = [
        {"id": guest_id, "name": f"Guest {guest_id}"}
        for guest_id in range(1, 5_001)
    ]

    payloads = {
        "auth": {
            "id": 1,
            "name": "Benchmark User",
            "roles": [f"role-{index}" for index in range(100)],
        },
        "hotel": {
            "id": 10,
            "name": "Benchmark Hotel",
            "amenities": [f"amenity-{index}" for index in range(200)],
        },
        "permissions": [f"permission:{index}" for index in range(500)],
        "settings": {
            f"feature-{index}": index % 3 == 0
            for index in range(500)
        }
        | {"currency": "MYR", "timezone": "Asia/Kuala_Lumpur"},
        "summary": {"rooms": len(rooms), "guests": len(guests)},
        "recent-bookings": [
            {"id": index, "guest_id": index, "room_id": (index % 1_000) + 1}
            for index in range(1, 101)
        ],
        "room-types": ["standard", "suite"],
        "rooms": rooms,
    }

    def load(key: str):
        counts[key] = counts.get(key, 0) + 1
        return payloads[key]

    def shared_resources():
        return [
            resource("auth", lambda: load("auth"), scope=scope.user(1), ttl=300),
            resource("hotel", lambda: load("hotel"), scope=scope.tenant(10), ttl=300),
            resource("permissions", lambda: load("permissions"), scope=scope.user(1), ttl=300),
            resource("settings", lambda: load("settings"), scope=scope.tenant(10), ttl=300),
        ]

    @flux.page("/dashboard")
    async def dashboard():
        return Page(
            "dashboard/index",
            resources=shared_resources()
            + [
                resource("summary", lambda: load("summary"), scope=scope.tenant(10), ttl=60),
                resource(
                    "recent-bookings",
                    lambda: load("recent-bookings"),
                    scope=scope.tenant(10),
                    ttl=60,
                ),
            ],
        )

    @flux.page("/rooms")
    async def rooms_page():
        return Page(
            "rooms/index",
            resources=shared_resources()
            + [
                resource("room-types", lambda: load("room-types"), scope=scope.tenant(10), ttl=60),
                resource("rooms", lambda: load("rooms"), scope=scope.tenant(10), ttl=60),
            ],
        )

    @app.get("/baseline/rooms")
    async def baseline_rooms():
        return JSONResponse(
            {
                "component": "rooms/index",
                "props": {
                    key: payloads[key]
                    for key in (
                        "auth",
                        "hotel",
                        "permissions",
                        "settings",
                        "room-types",
                        "rooms",
                    )
                },
            }
        )

    return app, counts
