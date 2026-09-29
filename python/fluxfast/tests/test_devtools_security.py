"""Adversarial guarantees for the development-only trace channel."""

import base64
import json

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from fluxfast import FluxFast, Page, resource, scope
from fluxfast.devtools import (
    HEADER_DEVTOOLS,
    HEADER_DEVTOOLS_TRACE,
    MAX_DEVTOOLS_TRACE_HEADER_BYTES,
    RequestDiagnosticCollector,
    diagnostics_requested,
)
from fluxfast.headers import HEADER_FLUXFAST


def _decode(value: str) -> dict[str, object]:
    padding = "=" * (-len(value) % 4)
    return json.loads(base64.urlsafe_b64decode(value + padding))


@pytest.mark.parametrize(
    "header_value",
    [
        None,
        "",
        "0",
        " 1",
        "1 ",
        "1\r\nX-Injected: true",
        "１",
        "true",
    ],
)
def test_malicious_opt_in_headers_cannot_enable_diagnostics(header_value):
    assert diagnostics_requested(debug=True, header_value=header_value) is False
    assert diagnostics_requested(debug=False, header_value=header_value) is False


def test_trace_serialization_excludes_sensitive_values_and_bounds_hostile_keys():
    secrets = {
        "password": "password-value-7d29",
        "token": "token-value-8f31",
        "cookie": "session=cookie-value-2c91",
        "authorization": "Bearer authorization-value-4f20",
        "tenant_id": "tenant-private-101",
        "user_id": "user-private-202",
        "resource_value": "resource-private-303",
        "redis_url": "redis://:password@private.example/0",
    }
    keys = [
        "<script>globalThis.fluxfastPolluted=true</script>",
        "__proto__",
        "constructor",
        "prototype",
    ]
    app = FastAPI()
    flux = FluxFast(app, debug=True)
    tenant_scope = scope.tenant(secrets["tenant_id"])

    @flux.page("/hostile")
    def hostile_page():
        return Page(
            "hostile/index",
            [
                resource(
                    key,
                    lambda: dict(secrets),
                    scope=tenant_scope,
                    ttl=60,
                )
                for key in keys
            ],
        )

    response = TestClient(app).get(
        f"/hostile?token={secrets['token']}&user={secrets['user_id']}",
        headers={
            HEADER_FLUXFAST: "1",
            HEADER_DEVTOOLS: "1",
            "Authorization": secrets["authorization"],
            "Cookie": secrets["cookie"],
            "X-Redis-Url": secrets["redis_url"],
        },
    )

    assert response.status_code == 200
    encoded = response.headers[HEADER_DEVTOOLS_TRACE]
    assert len(encoded.encode("ascii")) <= MAX_DEVTOOLS_TRACE_HEADER_BYTES
    assert "\r" not in encoded and "\n" not in encoded
    trace = _decode(encoded)
    serialized = json.dumps(trace)
    for value in secrets.values():
        assert value not in serialized
    assert [item["key"] for item in trace["resources"]] == keys

    collector = RequestDiagnosticCollector("page")
    diagnostic = collector.start_resource(
        key="rooms\r\nX-Injected: true",
        scope_type="tenant",
        ttl=60,
        deferred=False,
        live=False,
        cache_backend="memory",
    )
    assert diagnostic is not None
    assert diagnostic.key == "roomsX-Injected: true"


def test_oversized_trace_is_truncated_without_failing_the_page_request():
    app = FastAPI()
    flux = FluxFast(app, debug=True)
    specs = [
        resource(
            f"resource-{index:03d}-" + "x" * 100,
            lambda index=index: {
                "index": index,
                "secret": f"resource-value-{index}",
            },
            scope=scope.public(),
            ttl=60,
        )
        for index in range(256)
    ]

    @flux.page("/large")
    def large_page():
        return Page("large/index", specs)

    response = TestClient(app).get(
        "/large?authorization=must-not-survive",
        headers={HEADER_FLUXFAST: "1", HEADER_DEVTOOLS: "1"},
    )

    assert response.status_code == 200
    encoded = response.headers[HEADER_DEVTOOLS_TRACE]
    assert len(encoded.encode("ascii")) <= MAX_DEVTOOLS_TRACE_HEADER_BYTES
    trace = _decode(encoded)
    assert trace["truncated"] is True
    assert len(trace["resources"]) < 256
    serialized = json.dumps(trace)
    assert "must-not-survive" not in serialized
    assert "resource-value-" not in serialized
