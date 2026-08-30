"""Tests for authenticated, page-scoped Live Resource SSE streams."""

import json

import anyio.lowlevel
import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

from fluxfast import (
    CAPABILITY_LIVE_RESOURCES,
    FluxFast,
    LiveCoordinator,
    MemoryLiveBroker,
    MemoryResourceCache,
    Page,
    iter_live_events,
    resource,
    scope,
)
from fluxfast.errors import ProtocolError
from fluxfast.headers import (
    HEADER_CAPABILITIES,
    HEADER_CLIENT_ID,
    HEADER_FLUXFAST,
    HEADER_LIVE,
    HEADER_LIVE_KEYS,
    HEADER_PROTOCOL,
    MAX_CLIENT_ID_LENGTH,
    MAX_LIVE_KEYS,
    MAX_LIVE_KEYS_HEADER_BYTES,
    parse_live_keys_header,
    validate_live_client_id,
)


def _live_headers(keys: str) -> dict[str, str]:
    return {
        "Accept": "text/event-stream",
        HEADER_FLUXFAST: "1",
        HEADER_PROTOCOL: "1",
        HEADER_LIVE: "1",
        HEADER_LIVE_KEYS: keys,
        HEADER_CLIENT_ID: "ff_test",
        HEADER_CAPABILITIES: CAPABILITY_LIVE_RESOURCES,
    }


def _sse_payloads(body: str) -> list[dict[str, object]]:
    return [
        json.loads(line.removeprefix("data: "))
        for line in body.splitlines()
        if line.startswith("data: ")
    ]


def test_live_request_reconstructs_page_without_running_loaders() -> None:
    app = FastAPI()
    flux = FluxFast(
        app,
        live_max_connection_age=0.03,
        live_heartbeat_interval=0.005,
    )
    calls = {"dependency": 0, "page": 0, "loader": 0}

    def authorize() -> str:
        calls["dependency"] += 1
        return "tenant-secret"

    def load_summary() -> dict[str, int]:
        calls["loader"] += 1
        return {"count": 1}

    @flux.page("/dashboard")
    async def dashboard(tenant: str = Depends(authorize)) -> Page:
        calls["page"] += 1
        return Page(
            "Dashboard",
            [
                resource(
                    "summary",
                    load_summary,
                    scope=scope.tenant(tenant),
                    live=True,
                )
            ],
        )

    response = TestClient(app).get(
        "/dashboard",
        headers=_live_headers("summary,invented"),
    )

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/event-stream")
    assert response.headers["cache-control"] == "no-cache, no-transform"
    assert response.headers["x-accel-buffering"] == "no"
    assert _sse_payloads(response.text) == [
        {"protocol": "fluxfast/1", "type": "ready", "keys": ["summary"]}
    ]
    assert ": ping" in response.text
    assert "tenant-secret" not in response.text
    assert calls == {"dependency": 1, "page": 1, "loader": 0}
    assert flux.live.broker.subscriber_count == 0


def test_live_request_rejects_undeclared_keys_and_missing_capability() -> None:
    app = FastAPI()
    flux = FluxFast(app)

    @flux.page("/dashboard")
    async def dashboard() -> Page:
        return Page(
            "Dashboard",
            [resource("summary", dict, scope=scope.public(), live=True)],
        )

    undeclared = TestClient(app).get(
        "/dashboard",
        headers=_live_headers("invented"),
    )
    assert undeclared.status_code == 409
    assert "declared by this page" in undeclared.json()["error"]["message"]

    headers = _live_headers("summary")
    del headers[HEADER_CAPABILITIES]
    unsupported = TestClient(app).get("/dashboard", headers=headers)
    assert unsupported.status_code == 409
    assert "live-resources capability" in unsupported.json()["error"]["message"]


@pytest.mark.anyio
async def test_stream_forwards_published_events_and_cleans_up() -> None:
    broker = MemoryLiveBroker()
    coordinator = LiveCoordinator(MemoryResourceCache(), broker)
    resource_scope = scope.user("alice")
    page = Page(
        "Profile",
        [resource("profile", dict, scope=resource_scope, live=True)],
    )
    subscription = coordinator.resolve_subscription(page, {"profile"})
    stream = iter_live_events(
        coordinator,
        subscription,
        heartbeat_interval=1,
        max_connection_age=10,
    )

    ready = await anext(stream)
    assert b'"type":"ready"' in ready
    while broker.subscriber_count != 1:
        await anyio.lowlevel.checkpoint()

    await coordinator.invalidate("profile", scope=resource_scope)
    event = await anext(stream)
    assert b'"type":"invalidate"' in event
    assert b'"keys":["profile"]' in event

    await stream.aclose()
    assert broker.subscriber_count == 0


def test_live_header_limits_and_client_id_validation() -> None:
    assert parse_live_keys_header("summary, activity,summary") == {
        "summary",
        "activity",
    }
    assert validate_live_client_id("ff_valid") == "ff_valid"

    for invalid in (None, "", "bad,,key"):
        with pytest.raises(ProtocolError, match="Live-Keys"):
            parse_live_keys_header(invalid)
    with pytest.raises(ProtocolError, match="at most"):
        parse_live_keys_header(",".join(f"key-{i}" for i in range(MAX_LIVE_KEYS + 1)))
    with pytest.raises(ProtocolError, match="exceeds"):
        parse_live_keys_header("x" * (MAX_LIVE_KEYS_HEADER_BYTES + 1))
    with pytest.raises(ProtocolError, match="printable ASCII"):
        validate_live_client_id("x" * (MAX_CLIENT_ID_LENGTH + 1))


def test_live_timing_configuration_is_bounded() -> None:
    for kwargs in (
        {"live_max_connection_age": 0},
        {"live_max_connection_age": float("inf")},
        {"live_heartbeat_interval": -1},
        {"live_heartbeat_interval": True},
    ):
        with pytest.raises(ValueError, match="finite positive"):
            FluxFast(FastAPI(), **kwargs)  # type: ignore[arg-type]
