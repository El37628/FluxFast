"""Tests for protocol definitions, version hashing, and headers."""

from dataclasses import dataclass
from datetime import UTC, datetime
from decimal import Decimal
from uuid import UUID

import pytest
from pydantic import BaseModel
from pydantic import ValidationError as PydanticValidationError

from fluxfast.headers import (
    MAX_ENCODED_CHARS,
    MAX_KNOWN_RESOURCES,
    encode_known_header,
    parse_known_header,
    parse_only_header,
)
from fluxfast.protocol import (
    PROTOCOL_VERSION,
    PageDescriptor,
    PageEnvelope,
    ResourceErrorDetail,
    ResourceWireRecord,
)
from fluxfast.serialization import canonical_json, compute_version, to_jsonable


def test_canonical_json_ordering():
    data1 = {"b": 2, "a": 1, "nested": {"z": 10, "y": 20}}
    data2 = {"a": 1, "nested": {"y": 20, "z": 10}, "b": 2}
    assert canonical_json(data1) == canonical_json(data2)
    assert canonical_json(data1) == '{"a":1,"b":2,"nested":{"y":20,"z":10}}'


def test_compute_version_stability():
    val1 = {"title": "Test", "count": 42}
    val2 = {"count": 42, "title": "Test"}
    ver1 = compute_version(val1)
    ver2 = compute_version(val2)
    assert ver1 == ver2
    assert len(ver1) == 32  # 16 bytes hex = 32 chars


def test_compute_version_distinct_for_changes():
    ver1 = compute_version({"count": 1})
    ver2 = compute_version({"count": 2})
    assert ver1 != ver2


def test_wire_serialization_and_hashing_use_the_same_representation():
    @dataclass
    class Item:
        amount: Decimal

    class Payload(BaseModel):
        item: Item
        created_at: datetime
        identifier: UUID

    value = Payload(
        item=Item(amount=Decimal("1.20")),
        created_at=datetime(2026, 8, 28, tzinfo=UTC),
        identifier=UUID(int=1),
    )
    wire = to_jsonable(value)

    assert wire == {
        "item": {"amount": "1.20"},
        "created_at": "2026-08-28T00:00:00Z",
        "identifier": "00000000-0000-0000-0000-000000000001",
    }
    assert canonical_json(value) == canonical_json(wire)
    assert compute_version(value) == compute_version(wire)


def test_page_envelope_model():
    envelope = PageEnvelope(
        protocol=PROTOCOL_VERSION,
        page=PageDescriptor(component="dashboard/index", url="/dashboard"),
        resources={
            "auth": ResourceWireRecord(version="abc12345", value={"user": "admin"})
        },
    )
    dumped = envelope.model_dump(mode="json")
    assert dumped["protocol"] == "fluxfast/1"
    assert dumped["page"]["component"] == "dashboard/index"
    assert dumped["resources"]["auth"]["version"] == "abc12345"
    assert dumped["resources"]["auth"]["value"] == {"user": "admin"}


def test_page_envelope_accepts_optional_resource_metadata():
    envelope = PageEnvelope(
        page=PageDescriptor(component="dashboard/index", url="/dashboard"),
        resources={},
        resourceKeys=["auth", "analytics"],
        deferred=["analytics"],
        live=["auth", "analytics"],
        resourceErrors={
            "activity": ResourceErrorDetail(
                type="ResourceError",
                message="A deferred resource could not be resolved",
            )
        },
    )

    dumped = envelope.model_dump(mode="json", exclude_none=True)
    assert dumped["resourceKeys"] == ["auth", "analytics"]
    assert dumped["deferred"] == ["analytics"]
    assert dumped["live"] == ["auth", "analytics"]
    assert dumped["resourceErrors"] == {
        "activity": {
            "type": "ResourceError",
            "message": "A deferred resource could not be resolved",
        }
    }


def test_page_envelope_keeps_resource_metadata_optional():
    envelope = PageEnvelope.model_validate(
        {
            "protocol": "fluxfast/1",
            "page": {"component": "dashboard/index", "url": "/dashboard"},
            "resources": {},
        }
    )

    assert envelope.resourceKeys is None
    assert envelope.deferred is None
    assert envelope.live is None
    assert envelope.resourceErrors is None


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("resourceKeys", "auth"),
        ("resourceKeys", ["auth", 1]),
        ("deferred", {"analytics": True}),
        ("deferred", [None]),
        ("live", "auth"),
        ("live", [1]),
        ("resourceErrors", []),
        ("resourceErrors", {"activity": {"type": "ResourceError"}}),
    ],
)
def test_page_envelope_rejects_malformed_resource_metadata(field, value):
    payload = {
        "protocol": "fluxfast/1",
        "page": {"component": "dashboard/index", "url": "/dashboard"},
        "resources": {},
        field: value,
    }

    with pytest.raises(PydanticValidationError):
        PageEnvelope.model_validate(payload)


def test_known_headers_roundtrip():
    known = {"auth": "ver1", "rooms": "ver2", "stats": "ver3"}
    encoded = encode_known_header(known)
    decoded = parse_known_header(encoded)
    assert decoded == known


def test_known_header_limits():
    large_map = {f"k{i}": f"v{i}" for i in range(200)}
    encoded = encode_known_header(large_map)
    decoded = parse_known_header(encoded)
    assert len(decoded) <= MAX_KNOWN_RESOURCES


def test_known_header_invalid():
    assert parse_known_header(None) == {}
    assert parse_known_header("") == {}
    assert parse_known_header("invalid base64 %%%") == {}
    assert parse_known_header("a" * (MAX_ENCODED_CHARS + 1)) == {}


def test_only_header():
    assert parse_only_header("rooms, summary, auth") == {"rooms", "summary", "auth"}
    assert parse_only_header(None) is None
    assert parse_only_header("   ") is None
