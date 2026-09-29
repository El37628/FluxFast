"""Development trace activation, safety, bounds, and resource timing tests."""

import base64
import json

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from fluxfast import (
    FluxFast,
    MemoryResourceCache,
    Page,
    append_item,
    flux_external_redirect,
    invalidate_resource,
    merge_object,
    mutation,
    resource,
    scope,
)
from fluxfast.devtools import (
    DEVTOOLS_PROTOCOL,
    HEADER_DEVTOOLS,
    HEADER_DEVTOOLS_TRACE,
    MAX_DEVTOOLS_TRACE_HEADER_BYTES,
    RequestDiagnosticCollector,
    classify_cache_backend,
    diagnostics_requested,
    encode_diagnostic_trace,
)
from fluxfast.engine import ResourceEngine
from fluxfast.headers import HEADER_FLUXFAST
from fluxfast.redis_cache import RedisResourceCache
from fluxfast.timing import TimingMetrics


def _decode_trace(value: str) -> dict[str, object]:
    padding = "=" * (-len(value) % 4)
    decoded = base64.urlsafe_b64decode(value + padding)
    return json.loads(decoded)


def _trace_app(*, debug: bool) -> FastAPI:
    app = FastAPI()
    flux = FluxFast(app, debug=debug)

    @flux.page("/dashboard")
    def dashboard():
        return Page(
            "dashboard/index",
            [
                resource(
                    "summary",
                    lambda: {
                        "customer": "private customer",
                        "token": "must-not-leak",
                    },
                    scope=scope.tenant("private-tenant-42"),
                    ttl=60,
                )
            ],
        )

    return app


@pytest.mark.parametrize(
    ("debug", "header_value", "expected"),
    [
        (False, "1", False),
        (True, None, False),
        (True, "0", False),
        (True, "1", True),
    ],
)
def test_page_trace_requires_debug_and_exact_request_opt_in(
    debug,
    header_value,
    expected,
):
    headers = {HEADER_FLUXFAST: "1"}
    if header_value is not None:
        headers[HEADER_DEVTOOLS] = header_value

    response = TestClient(_trace_app(debug=debug)).get(
        "/dashboard?authorization=secret",
        headers=headers,
    )

    assert response.status_code == 200
    assert (HEADER_DEVTOOLS_TRACE in response.headers) is expected
    if not expected:
        return

    encoded = response.headers[HEADER_DEVTOOLS_TRACE]
    trace = _decode_trace(encoded)
    assert len(encoded.encode("ascii")) <= MAX_DEVTOOLS_TRACE_HEADER_BYTES
    assert trace["protocol"] == DEVTOOLS_PROTOCOL
    assert trace["type"] == "page"
    assert str(trace["requestId"]).startswith("ffdev_")
    assert trace["resources"] == [
        {
            "key": "summary",
            "result": "loader",
            "durationMs": pytest.approx(trace["resources"][0]["durationMs"]),
            "scope": "tenant",
            "ttl": 60.0,
            "deferred": False,
            "live": False,
            "cacheBackend": "memory",
            "cacheResult": "miss",
            "sent": True,
            "knownVersion": False,
            "cacheMs": pytest.approx(trace["resources"][0]["cacheMs"]),
            "loaderMs": pytest.approx(trace["resources"][0]["loaderMs"]),
        }
    ]
    serialized = json.dumps(trace)
    assert "private customer" not in serialized
    assert "must-not-leak" not in serialized
    assert "private-tenant-42" not in serialized
    assert "authorization" not in serialized


def test_diagnostics_activation_cannot_be_enabled_by_header_alone():
    assert diagnostics_requested(debug=False, header_value="1") is False
    assert diagnostics_requested(debug=True, header_value=None) is False
    assert diagnostics_requested(debug=True, header_value="1") is True


def test_cache_backend_classification_is_bounded_to_known_categories():
    class CustomCache:
        pass

    redis = RedisResourceCache(object(), namespace="devtools-test")  # type: ignore[arg-type]

    assert classify_cache_backend(MemoryResourceCache()) == "memory"
    assert classify_cache_backend(redis) == "redis"
    assert classify_cache_backend(CustomCache()) == "custom"  # type: ignore[arg-type]


@pytest.mark.anyio
async def test_resource_engine_records_cache_loader_known_and_deferred_states():
    cache = MemoryResourceCache()
    page = Page(
        "dashboard/index",
        [
            resource(
                "summary",
                lambda: {"count": 1},
                scope=scope.public(),
                ttl=60,
            ),
            resource("analytics", lambda: {"visits": 42}, defer=True),
        ],
    )
    first = RequestDiagnosticCollector("page")

    initial = await ResourceEngine.resolve_page_resources(
        page,
        {},
        None,
        cache,
        TimingMetrics(),
        client_supports_deferred=True,
        diagnostics=first,
    )

    by_key = {item.key: item for item in first.resources}
    assert by_key["summary"].result == "loader"
    assert by_key["summary"].cache_result == "miss"
    assert by_key["summary"].cache_ms is not None
    assert by_key["summary"].loader_ms is not None
    assert by_key["summary"].sent is True
    assert by_key["analytics"].result == "deferred"
    assert by_key["analytics"].cache_result == "bypass"
    assert initial.deferred == ["analytics"]

    second = RequestDiagnosticCollector("page")
    await ResourceEngine.resolve_page_resources(
        page,
        {"summary": initial.resources["summary"].version},
        None,
        cache,
        TimingMetrics(),
        client_supports_deferred=True,
        diagnostics=second,
    )
    warm = {item.key: item for item in second.resources}
    assert warm["summary"].result == "omitted-known"
    assert warm["summary"].cache_result == "hit"
    assert warm["summary"].known_version is True
    assert warm["summary"].sent is False


@pytest.mark.anyio
async def test_deferred_failure_records_only_a_bounded_error_category():
    async def fail():
        raise RuntimeError("database password and traceback must stay private")

    collector = RequestDiagnosticCollector("page")
    await ResourceEngine.resolve_page_resources(
        Page("dashboard/index", [resource("activity", fail, defer=True)]),
        {},
        {"activity"},
        MemoryResourceCache(),
        TimingMetrics(),
        client_supports_deferred=True,
        diagnostics=collector,
    )

    diagnostic = collector.resources[0]
    assert diagnostic.result == "error"
    assert diagnostic.error_type == "ResourceError"
    trace = encode_diagnostic_trace(
        collector.build(page_ms=1, resources_ms=2, serialize_ms=3)
    )
    assert trace is not None
    serialized = json.dumps(_decode_trace(trace))
    assert "password" not in serialized
    assert "traceback" not in serialized


def test_trace_encoding_drops_resource_details_to_respect_header_bound():
    collector = RequestDiagnosticCollector("page")
    for index in range(300):
        diagnostic = collector.start_resource(
            key=f"resource-{index}-" + "x" * 100,
            scope_type="custom",
            ttl=60,
            deferred=False,
            live=False,
            cache_backend="custom",
        )
        collector.finish_resource(diagnostic, result="loader", sent=True)

    encoded = encode_diagnostic_trace(
        collector.build(page_ms=1, resources_ms=2, serialize_ms=3),
        maximum_bytes=700,
    )

    assert encoded is not None
    assert len(collector.resources) == 256
    assert collector.truncated is True
    assert len(encoded.encode("ascii")) <= 700
    decoded = _decode_trace(encoded)
    assert decoded["truncated"] is True
    assert len(decoded["resources"]) < 256


def test_trace_encoding_fails_closed_when_even_metadata_cannot_fit():
    collector = RequestDiagnosticCollector("page")
    trace = collector.build(page_ms=1, resources_ms=2, serialize_ms=3)

    assert encode_diagnostic_trace(trace, maximum_bytes=1) is None


@pytest.mark.parametrize(
    ("debug", "headers", "expected"),
    [
        (False, {HEADER_DEVTOOLS: "1"}, False),
        (True, {}, False),
        (True, {HEADER_DEVTOOLS: "1"}, True),
    ],
)
def test_mutation_trace_activation_and_safe_counts(debug, headers, expected):
    app = FastAPI()
    flux = FluxFast(app, debug=debug)
    tenant_scope = scope.tenant("private-hotel-42")

    @flux.mutation("/rooms")
    async def update_room(payload: dict[str, str]):
        assert payload["password"] == "request-body-secret"
        return mutation(
            patches={
                "rooms": [
                    merge_object({"guest": "private-patch-value"}),
                    merge_object({"status": "occupied"}),
                    append_item({"card": "private-card-number"}),
                ]
            },
            invalidates=[
                "summary",
                invalidate_resource("availability", scope=tenant_scope),
            ],
            redirect="/rooms?token=redirect-secret",
        )

    response = TestClient(app).post(
        "/rooms?token=request-url-secret",
        headers={HEADER_FLUXFAST: "1", **headers},
        json={"password": "request-body-secret"},
    )

    assert response.status_code == 200
    assert (HEADER_DEVTOOLS_TRACE in response.headers) is expected
    if not expected:
        return

    trace = _decode_trace(response.headers[HEADER_DEVTOOLS_TRACE])
    assert trace["protocol"] == DEVTOOLS_PROTOCOL
    assert trace["type"] == "mutation"
    assert trace["patches"] == [
        {
            "key": "rooms",
            "operations": {"append-item": 1, "merge-object": 2},
        }
    ]
    assert trace["invalidated"] == ["summary", "availability"]
    assert trace["invalidationCount"] == 2
    assert trace["liveSignals"] == 1
    assert trace["redirect"] == "internal"
    for timing in ("durationMs", "handlerMs", "invalidationMs", "serializeMs"):
        assert trace[timing] >= 0
    serialized = json.dumps(trace)
    for forbidden in (
        "request-body-secret",
        "private-patch-value",
        "private-card-number",
        "private-hotel-42",
        "redirect-secret",
        "request-url-secret",
        "password",
    ):
        assert forbidden not in serialized


def test_page_decorator_mutation_result_uses_mutation_trace_shape():
    app = FastAPI()
    flux = FluxFast(app, debug=True)

    @flux.page("/legacy-mutation")
    def legacy_mutation():
        return mutation(invalidate=["summary"])

    response = TestClient(app).get(
        "/legacy-mutation",
        headers={HEADER_FLUXFAST: "1", HEADER_DEVTOOLS: "1"},
    )

    assert response.status_code == 200
    trace = _decode_trace(response.headers[HEADER_DEVTOOLS_TRACE])
    assert trace["type"] == "mutation"
    assert trace["invalidated"] == ["summary"]
    assert "resources" not in trace


def test_external_redirect_trace_records_only_the_redirect_kind():
    app = FastAPI()
    flux = FluxFast(app, debug=True)

    @flux.mutation("/login")
    def login():
        return flux_external_redirect(
            "https://identity.example.com/login?token=private-redirect-token"
        )

    response = TestClient(app).post(
        "/login",
        headers={HEADER_FLUXFAST: "1", HEADER_DEVTOOLS: "1"},
    )

    trace = _decode_trace(response.headers[HEADER_DEVTOOLS_TRACE])
    assert trace["redirect"] == "external"
    assert "identity.example.com" not in json.dumps(trace)
    assert "private-redirect-token" not in json.dumps(trace)


def test_mutation_trace_drops_detail_lists_before_exceeding_header_bound():
    collector = RequestDiagnosticCollector("mutation")
    patches = {
        f"resource-{index}-" + "x" * 100: [
            {"op": "merge-object", "value": {"secret": "not-recorded"}}
        ]
        for index in range(100)
    }
    invalidated = [f"invalidated-{index}-" + "y" * 100 for index in range(100)]
    collector.record_mutation(
        handler_ms=1,
        invalidation_ms=2,
        serialize_ms=3,
        patches=patches,
        invalidated=invalidated,
        live_signals=100,
        redirect="none",
    )

    encoded = encode_diagnostic_trace(
        collector.build(page_ms=0, resources_ms=0, serialize_ms=3),
        maximum_bytes=700,
    )

    assert encoded is not None
    assert len(encoded.encode("ascii")) <= 700
    trace = _decode_trace(encoded)
    assert trace["truncated"] is True
    assert len(trace["patches"]) < 100
    assert trace["invalidationCount"] == 100
    assert "not-recorded" not in json.dumps(trace)
