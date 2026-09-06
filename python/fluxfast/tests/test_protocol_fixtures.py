"""Cross-language golden fixtures for the frozen fluxfast/1 contract."""

import json
from pathlib import Path
from typing import Any

import pytest
from pydantic import ValidationError as PydanticValidationError

from fluxfast.capabilities import (
    CAPABILITY_DEFERRED_RESOURCES,
    CAPABILITY_LIVE_RESOURCES,
    MAX_CAPABILITIES,
    MAX_CAPABILITIES_HEADER_BYTES,
    MAX_CAPABILITY_LENGTH,
)
from fluxfast.headers import (
    HEADER_CAPABILITIES,
    HEADER_CLIENT_ID,
    HEADER_FLUXFAST,
    HEADER_KNOWN,
    HEADER_LIVE,
    HEADER_LIVE_KEYS,
    HEADER_ONLY,
    HEADER_PROTOCOL,
    HEADER_VISIT,
    MAX_CLIENT_ID_LENGTH,
    MAX_DECODED_BYTES,
    MAX_KEY_LENGTH,
    MAX_KNOWN_RESOURCES,
    MAX_LIVE_KEYS,
    MAX_LIVE_KEYS_HEADER_BYTES,
    MAX_VERSION_LENGTH,
)
from fluxfast.protocol import (
    PROTOCOL_MEDIA_TYPE,
    PROTOCOL_VERSION,
    ErrorEnvelope,
    MutationEnvelope,
    PageEnvelope,
)

FIXTURE_DIRECTORY = (
    Path(__file__).resolve().parents[3] / "tests" / "fixtures" / "protocol-v1"
)
PAGE_FIXTURES = {
    "deferred-error.json",
    "deferred-page.json",
    "known-version-delta.json",
    "live-page.json",
    "normal-page.json",
    "partial-resource-load.json",
}
MUTATION_FIXTURES = {
    "external-redirect.json",
    "mutation-invalidation.json",
    "mutation-patch.json",
    "redirect.json",
}
ERROR_FIXTURES = {"resource-error.json", "validation-error.json"}


def load_fixture(name: str) -> dict[str, Any]:
    return json.loads((FIXTURE_DIRECTORY / name).read_text(encoding="utf-8"))


def test_protocol_fixture_inventory_is_complete() -> None:
    actual = {path.name for path in FIXTURE_DIRECTORY.glob("*.json")}
    assert actual == PAGE_FIXTURES | MUTATION_FIXTURES | ERROR_FIXTURES


@pytest.mark.parametrize(
    ("fixture_name", "model_type"),
    [
        *((name, PageEnvelope) for name in sorted(PAGE_FIXTURES)),
        *((name, MutationEnvelope) for name in sorted(MUTATION_FIXTURES)),
        *((name, ErrorEnvelope) for name in sorted(ERROR_FIXTURES)),
    ],
)
def test_python_models_round_trip_protocol_fixtures(
    fixture_name: str,
    model_type: type[PageEnvelope] | type[MutationEnvelope] | type[ErrorEnvelope],
) -> None:
    payload = load_fixture(fixture_name)
    envelope = model_type.model_validate(payload)

    assert envelope.model_dump(
        mode="json",
        exclude_unset=True,
    ) == payload


def test_page_envelope_preserves_optional_app_version() -> None:
    payload = load_fixture("normal-page.json")
    envelope = PageEnvelope.model_validate(payload)

    assert envelope.appVersion == "2026.09.06"
    with pytest.raises(PydanticValidationError):
        PageEnvelope.model_validate({**payload, "appVersion": {"invalid": True}})


@pytest.mark.parametrize(
    "mutation",
    [
        {"invalidate": [None]},
        {"redirect": "https://example.com/rooms"},
        {"redirect": "//example.com/rooms"},
        {"externalRedirect": "/login"},
        {"externalRedirect": "javascript:alert(1)"},
        {"patches": {"rooms": [{"op": "merge-object", "value": 1}]}},
        {"patches": {"rooms": [{"op": "remove-item", "id": {}}]}},
        {"patches": {"rooms": [{"op": "remove-item", "match": []}]}},
    ],
)
def test_python_producer_rejects_malformed_mutation_payloads(
    mutation: dict[str, Any],
) -> None:
    with pytest.raises(PydanticValidationError):
        MutationEnvelope.model_validate(
            {"protocol": "fluxfast/1", "mutation": mutation}
        )


def test_protocol_identity_capabilities_and_header_limits_are_frozen() -> None:
    assert PROTOCOL_VERSION == "fluxfast/1"
    assert PROTOCOL_MEDIA_TYPE == "application/vnd.fluxfast+json"
    assert {
        "fluxfast": HEADER_FLUXFAST,
        "protocol": HEADER_PROTOCOL,
        "visit": HEADER_VISIT,
        "known": HEADER_KNOWN,
        "only": HEADER_ONLY,
        "capabilities": HEADER_CAPABILITIES,
        "client_id": HEADER_CLIENT_ID,
        "live": HEADER_LIVE,
        "live_keys": HEADER_LIVE_KEYS,
    } == {
        "fluxfast": "X-FluxFast",
        "protocol": "X-FluxFast-Protocol",
        "visit": "X-FluxFast-Visit",
        "known": "X-FluxFast-Known",
        "only": "X-FluxFast-Only",
        "capabilities": "X-FluxFast-Capabilities",
        "client_id": "X-FluxFast-Client-ID",
        "live": "X-FluxFast-Live",
        "live_keys": "X-FluxFast-Live-Keys",
    }
    assert {
        CAPABILITY_DEFERRED_RESOURCES,
        CAPABILITY_LIVE_RESOURCES,
    } == {"deferred-resources", "live-resources"}
    assert (
        MAX_KNOWN_RESOURCES,
        MAX_DECODED_BYTES,
        MAX_KEY_LENGTH,
        MAX_VERSION_LENGTH,
    ) == (100, 16 * 1024, 128, 128)
    assert (
        MAX_CAPABILITIES_HEADER_BYTES,
        MAX_CAPABILITIES,
        MAX_CAPABILITY_LENGTH,
    ) == (2048, 32, 64)
    assert (
        MAX_LIVE_KEYS_HEADER_BYTES,
        MAX_LIVE_KEYS,
        MAX_CLIENT_ID_LENGTH,
    ) == (16 * 1024, 100, 64)
