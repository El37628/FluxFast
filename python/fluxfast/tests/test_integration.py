"""End-to-end integration tests for FastAPI routing, shared resource reuse, and mutations."""

from fastapi import Depends, FastAPI, Request
from fastapi.testclient import TestClient
from pydantic import BaseModel

from fluxfast import (
    CAPABILITY_DEFERRED_RESOURCES,
    FluxFast,
    FluxRouter,
    Page,
    invalidate_resource,
    mutation,
    resource,
    scope,
)
from fluxfast.headers import (
    HEADER_CAPABILITIES,
    HEADER_FLUXFAST,
    HEADER_KNOWN,
    HEADER_ONLY,
    encode_known_header,
)


class User:
    def __init__(self, id: int, name: str):
        self.id = id
        self.name = name


class Hotel:
    def __init__(self, id: int, name: str):
        self.id = id
        self.name = name


def current_user() -> User:
    return User(id=1, name="Alice")


def current_hotel() -> Hotel:
    return Hotel(id=10, name="Seaside Resort")


def create_test_app() -> tuple[FastAPI, dict[str, int]]:
    app = FastAPI()
    FluxFast(app)
    router = FluxRouter()

    loader_counts = {
        "auth": 0,
        "hotel": 0,
        "permissions": 0,
        "settings": 0,
        "summary": 0,
        "recent_bookings": 0,
        "room_types": 0,
        "rooms": 0,
    }

    def load_auth(user: User):
        loader_counts["auth"] += 1
        return {"id": user.id, "name": user.name}

    def load_hotel(hotel: Hotel):
        loader_counts["hotel"] += 1
        return {"id": hotel.id, "name": hotel.name}

    def load_permissions(user: User):
        loader_counts["permissions"] += 1
        return ["read_rooms", "write_rooms"]

    def load_settings():
        loader_counts["settings"] += 1
        return {"theme": "dark", "currency": "USD"}

    def load_summary(hotel: Hotel):
        loader_counts["summary"] += 1
        return {"occupied": 42}

    def load_recent_bookings(hotel: Hotel):
        loader_counts["recent_bookings"] += 1
        return [{"id": 1, "guest": "Bob"}]

    def load_room_types(hotel: Hotel):
        loader_counts["room_types"] += 1
        return [{"id": 1, "name": "Deluxe"}]

    def load_rooms(hotel: Hotel):
        loader_counts["rooms"] += 1
        return [{"id": 101, "number": "101", "status": "clean"}]

    @router.page("/dashboard")
    async def dashboard_page(
        user: User = Depends(current_user),
        hotel: Hotel = Depends(current_hotel),
    ):
        return Page(
            component="dashboard/index",
            resources=[
                resource("auth", lambda: load_auth(user), scope=scope.user(user.id), ttl=300),
                resource("hotel", lambda: load_hotel(hotel), scope=scope.tenant(hotel.id), ttl=60),
                resource("permissions", lambda: load_permissions(user), scope=scope.user(user.id), ttl=300),
                resource("settings", load_settings, scope=scope.public(), ttl=300),
                resource("summary", lambda: load_summary(hotel), scope=scope.tenant(hotel.id), ttl=10),
                resource("recent_bookings", lambda: load_recent_bookings(hotel), scope=scope.tenant(hotel.id), ttl=10),
            ],
            meta={"title": "Dashboard"},
        )

    @router.page("/rooms")
    async def rooms_page(
        user: User = Depends(current_user),
        hotel: Hotel = Depends(current_hotel),
    ):
        return Page(
            component="rooms/index",
            resources=[
                resource("auth", lambda: load_auth(user), scope=scope.user(user.id), ttl=300),
                resource("hotel", lambda: load_hotel(hotel), scope=scope.tenant(hotel.id), ttl=60),
                resource("permissions", lambda: load_permissions(user), scope=scope.user(user.id), ttl=300),
                resource("settings", load_settings, scope=scope.public(), ttl=300),
                resource("room_types", lambda: load_room_types(hotel), scope=scope.tenant(hotel.id), ttl=60),
                resource("rooms", lambda: load_rooms(hotel), scope=scope.tenant(hotel.id), ttl=10),
            ],
            meta={"title": "Rooms"},
        )

    class CheckoutPayload(BaseModel):
        room_id: int
        notes: str

    @router.mutation("/rooms/checkout")
    async def checkout_room(payload: CheckoutPayload, hotel: Hotel = Depends(current_hotel)):
        return mutation(
            patch={
                "rooms": [
                    {
                        "op": "replace-item",
                        "id": payload.room_id,
                        "value": {"id": payload.room_id, "number": "101", "status": "occupied"},
                    }
                ]
            },
            invalidate=[
                invalidate_resource("summary", scope=scope.tenant(hotel.id)),
            ],
        )

    app.include_router(router)
    return app, loader_counts


def test_required_performance_cross_page_reuse_scenario():
    """Section 68 required performance benchmark scenario."""
    app, loader_counts = create_test_app()
    client = TestClient(app)

    # 1. Initial navigation to /dashboard
    resp1 = client.get("/dashboard", headers={HEADER_FLUXFAST: "1"})
    assert resp1.status_code == 200
    data1 = resp1.json()

    assert data1["protocol"] == "fluxfast/1"
    assert data1["page"]["component"] == "dashboard/index"
    assert "auth" in data1["resources"]
    assert "hotel" in data1["resources"]
    assert "permissions" in data1["resources"]
    assert "settings" in data1["resources"]
    assert "summary" in data1["resources"]
    assert "recent_bookings" in data1["resources"]

    # All initial 6 loaders executed once
    assert loader_counts["auth"] == 1
    assert loader_counts["hotel"] == 1
    assert loader_counts["permissions"] == 1
    assert loader_counts["settings"] == 1
    assert loader_counts["summary"] == 1
    assert loader_counts["recent_bookings"] == 1

    # Extract versions known by client
    known_versions = {
        k: rec["version"] for k, rec in data1["resources"].items()
    }
    encoded_known = encode_known_header(known_versions)

    # 2. Navigate to /rooms with known headers
    resp2 = client.get(
        "/rooms",
        headers={
            HEADER_FLUXFAST: "1",
            HEADER_KNOWN: encoded_known,
        },
    )
    assert resp2.status_code == 200
    data2 = resp2.json()

    assert data2["page"]["component"] == "rooms/index"

    # ASSERTION 1: 4 common resource values are NOT transferred again
    assert "auth" not in data2["resources"]
    assert "hotel" not in data2["resources"]
    assert "permissions" not in data2["resources"]
    assert "settings" not in data2["resources"]

    # ASSERTION 2: New resources ARE transferred
    assert "room_types" in data2["resources"]
    assert "rooms" in data2["resources"]

    # ASSERTION 3: 4 common loaders NOT executed again (cached on server)
    assert loader_counts["auth"] == 1
    assert loader_counts["hotel"] == 1
    assert loader_counts["permissions"] == 1
    assert loader_counts["settings"] == 1

    # New loaders executed once
    assert loader_counts["room_types"] == 1
    assert loader_counts["rooms"] == 1


def test_partial_refresh_only_header():
    app, _loader_counts = create_test_app()
    client = TestClient(app)

    # Request only 'summary'
    resp = client.get(
        "/dashboard",
        headers={
            HEADER_FLUXFAST: "1",
            HEADER_ONLY: "summary",
        },
    )
    assert resp.status_code == 200
    data = resp.json()

    # Only summary is resolved and returned
    assert "summary" in data["resources"]
    assert "auth" not in data["resources"]
    assert "hotel" not in data["resources"]


def test_deferred_page_metadata_requires_capability_and_only_resolves_follow_up():
    app = FastAPI()
    flux = FluxFast(app)
    loader_counts = {"summary": 0, "analytics": 0}

    def load_summary():
        loader_counts["summary"] += 1
        return {"occupied": 42}

    def load_analytics():
        loader_counts["analytics"] += 1
        return {"revenue": 95_000}

    @flux.page("/deferred")
    async def deferred_page():
        return Page(
            component="deferred/index",
            resources=[
                resource("summary", load_summary),
                resource("analytics", load_analytics, defer=True),
            ],
        )

    client = TestClient(app)

    legacy = client.get("/deferred", headers={HEADER_FLUXFAST: "1"})
    assert legacy.status_code == 200
    assert set(legacy.json()["resources"]) == {"summary", "analytics"}
    assert "resourceKeys" not in legacy.json()
    assert "deferred" not in legacy.json()
    assert loader_counts == {"summary": 1, "analytics": 1}

    capable_headers = {
        HEADER_FLUXFAST: "1",
        HEADER_CAPABILITIES: CAPABILITY_DEFERRED_RESOURCES,
    }
    initial = client.get("/deferred", headers=capable_headers)
    assert initial.status_code == 200
    assert set(initial.json()["resources"]) == {"summary"}
    assert initial.json()["resourceKeys"] == ["summary", "analytics"]
    assert initial.json()["deferred"] == ["analytics"]
    assert "resourceErrors" not in initial.json()
    assert loader_counts == {"summary": 2, "analytics": 1}

    follow_up = client.get(
        "/deferred",
        headers={**capable_headers, HEADER_ONLY: "analytics"},
    )
    assert follow_up.status_code == 200
    assert set(follow_up.json()["resources"]) == {"analytics"}
    assert follow_up.json()["resourceKeys"] == ["summary", "analytics"]
    assert "deferred" not in follow_up.json()
    assert loader_counts == {"summary": 2, "analytics": 2}


def test_mutation_and_cache_invalidation():
    app, loader_counts = create_test_app()
    client = TestClient(app)

    # Populate summary in cache
    client.get("/dashboard", headers={HEADER_FLUXFAST: "1"})
    assert loader_counts["summary"] == 1

    # Run mutation which invalidates summary for tenant 10
    mut_resp = client.post(
        "/rooms/checkout",
        json={"room_id": 101, "notes": "Guest left"},
        headers={HEADER_FLUXFAST: "1"},
    )
    assert mut_resp.status_code == 200
    mut_data = mut_resp.json()
    assert mut_data["protocol"] == "fluxfast/1"
    assert "rooms" in mut_data["mutation"]["patches"]

    # Request /dashboard again -> summary must re-execute because it was invalidated
    client.get("/dashboard", headers={HEADER_FLUXFAST: "1"})
    assert loader_counts["summary"] == 2


def test_validation_error_mapping_422():
    app, _ = create_test_app()
    client = TestClient(app)

    # Send invalid payload missing required fields
    resp = client.post(
        "/rooms/checkout",
        json={"room_id": "not_an_int"},
        headers={HEADER_FLUXFAST: "1"},
    )
    assert resp.status_code == 422
    data = resp.json()

    assert data["protocol"] == "fluxfast/1"
    assert data["error"]["type"] == "ValidationError"
    assert "room_id" in data["error"]["details"]
    assert "notes" in data["error"]["details"]


def test_page_url_preserves_search_parameters():
    app, _ = create_test_app()
    response = TestClient(app).get(
        "/rooms?status=available&page=2",
        headers={HEADER_FLUXFAST: "1"},
    )
    assert response.json()["page"]["url"] == "/rooms?status=available&page=2"


def test_protocol_mismatch_returns_fluxfast_error_envelope():
    app, _ = create_test_app()
    response = TestClient(app).get(
        "/dashboard",
        headers={HEADER_FLUXFAST: "1", "X-FluxFast-Protocol": "2"},
    )
    assert response.status_code == 409
    assert response.json()["error"]["type"] == "ProtocolError"


def test_fluxfast_convenience_decorator_registers_on_app():
    app = FastAPI()
    flux = FluxFast(app)

    @flux.page("/direct")
    async def direct_page():
        return Page(component="direct/index")

    response = TestClient(app).get("/direct", headers={HEADER_FLUXFAST: "1"})
    assert response.status_code == 200
    assert response.json()["page"]["component"] == "direct/index"


def test_resource_failure_returns_protocol_error_without_private_details():
    app = FastAPI()
    flux = FluxFast(app, debug=False)

    @flux.page("/failure")
    async def failure_page():
        def fail():
            raise RuntimeError("database password must stay private")

        return Page(component="failure/index", resources=[resource("failure", fail)])

    response = TestClient(app).get("/failure", headers={HEADER_FLUXFAST: "1"})
    assert response.status_code == 500
    assert response.json()["error"] == {
        "type": "ResourceError",
        "message": "A resource could not be resolved",
        "details": None,
    }


def test_user_parameter_named_request_does_not_replace_injected_request():
    app = FastAPI()
    flux = FluxFast(app)

    @flux.page("/request-name")
    async def request_name_page(request: str):
        return Page(component="request/index", meta={"value": request})

    response = TestClient(app).get(
        "/request-name?request=ordinary-query-value",
        headers={HEADER_FLUXFAST: "1"},
    )
    assert response.status_code == 200
    assert response.json()["page"]["meta"]["value"] == "ordinary-query-value"


def test_explicit_request_parameter_can_use_a_nonstandard_name():
    app = FastAPI()
    flux = FluxFast(app)

    @flux.page("/explicit-request")
    async def explicit_request_page(req: Request):
        return Page(component="request/index", meta={"path": req.url.path})

    response = TestClient(app).get(
        "/explicit-request",
        headers={HEADER_FLUXFAST: "1"},
    )
    assert response.status_code == 200
    assert response.json()["page"]["meta"]["path"] == "/explicit-request"
