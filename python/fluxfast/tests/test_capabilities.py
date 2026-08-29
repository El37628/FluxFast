"""Tests for bounded FluxFast client capability negotiation."""

from starlette.requests import Request

from fluxfast.capabilities import (
    CAPABILITY_DEFERRED_RESOURCES,
    HEADER_CAPABILITIES,
    MAX_CAPABILITIES,
    MAX_CAPABILITIES_HEADER_BYTES,
    client_supports,
    parse_capabilities_header,
)


def _request(header: str | None = None) -> Request:
    headers = []
    if header is not None:
        headers.append((HEADER_CAPABILITIES.lower().encode("ascii"), header.encode("latin-1")))
    return Request({"type": "http", "method": "GET", "path": "/", "headers": headers})


def test_missing_and_empty_capabilities_are_unsupported():
    assert parse_capabilities_header(None) == frozenset()
    assert parse_capabilities_header("") == frozenset()
    assert parse_capabilities_header("   ") == frozenset()
    assert not client_supports(_request(), CAPABILITY_DEFERRED_RESOURCES)


def test_supported_capability_is_detected_among_unknown_and_duplicate_tokens():
    parsed = parse_capabilities_header(
        "unknown-feature, deferred-resources,deferred-resources,live-resources"
    )

    assert parsed == frozenset({CAPABILITY_DEFERRED_RESOURCES})
    assert client_supports(
        _request("unknown-feature,deferred-resources"),
        CAPABILITY_DEFERRED_RESOURCES,
    )


def test_invalid_capability_tokens_are_ignored():
    assert parse_capabilities_header(
        "Deferred-Resources,deferred_resources,deferred resources,!,deferred-resources"
    ) == frozenset({CAPABILITY_DEFERRED_RESOURCES})


def test_oversized_or_overpopulated_capability_headers_fall_back_safely():
    oversized = "x" * (MAX_CAPABILITIES_HEADER_BYTES + 1)
    too_many = ",".join([CAPABILITY_DEFERRED_RESOURCES] * (MAX_CAPABILITIES + 1))

    assert parse_capabilities_header(oversized) == frozenset()
    assert parse_capabilities_header(too_many) == frozenset()
