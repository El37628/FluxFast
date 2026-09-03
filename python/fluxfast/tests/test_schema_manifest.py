"""Tests for the versioned offline FluxFast schema manifest."""

from __future__ import annotations

import json
import math
from collections.abc import Callable
from pathlib import Path

import pytest
from pydantic import ValidationError

from fluxfast.protocol import PROTOCOL_VERSION
from fluxfast.schema_manifest import (
    SCHEMA_MANIFEST_V2,
    SCHEMA_MANIFEST_VERSION,
    MutationRouteSchema,
    PageRouteSchema,
    ResourceSchemaEntry,
    RouteParameterSchema,
    SchemaManifest,
    TypeSchemaEntry,
)

FINGERPRINT = "a" * 64


def test_manifest_serializes_to_the_versioned_offline_shape() -> None:
    manifest = SchemaManifest(
        schema=SCHEMA_MANIFEST_VERSION,
        producer="0.6.0",
        fingerprint=FINGERPRINT,
        resources={
            "rooms": ResourceSchemaEntry(
                schema={
                    "type": "array",
                    "items": {"$ref": "#/$defs/Room"},
                    "$defs": {
                        "Room": {
                            "type": "object",
                            "properties": {"id": {"type": "integer"}},
                        }
                    },
                }
            )
        },
        pages=[
            PageRouteSchema(
                name="hotel_rooms",
                path="/hotels/{hotel_id}/rooms",
                parameters=[
                    RouteParameterSchema(
                        name="hotel_id",
                        location="path",
                        required=True,
                        schema={"type": "integer"},
                    )
                ],
            )
        ],
        mutations=[
            MutationRouteSchema(
                name="update_room",
                path="/rooms/{room_id}",
                method="PATCH",
                parameters=[
                    RouteParameterSchema(
                        name="room_id",
                        location="path",
                        required=True,
                        schema={"type": "integer"},
                    )
                ],
                body={
                    "type": "object",
                    "properties": {"status": {"enum": ["available", "occupied"]}},
                },
            )
        ],
    )

    assert manifest.model_dump(mode="json", by_alias=True, exclude_none=True) == {
        "schema": "fluxfast-schema/1",
        "producer": "0.6.0",
        "fingerprint": FINGERPRINT,
        "resources": {
            "rooms": {
                "schema": {
                    "type": "array",
                    "items": {"$ref": "#/$defs/Room"},
                    "$defs": {
                        "Room": {
                            "type": "object",
                            "properties": {"id": {"type": "integer"}},
                        }
                    },
                }
            }
        },
        "pages": [
            {
                "name": "hotel_rooms",
                "path": "/hotels/{hotel_id}/rooms",
                "parameters": [
                    {
                        "name": "hotel_id",
                        "location": "path",
                        "required": True,
                        "schema": {"type": "integer"},
                    }
                ],
            }
        ],
        "mutations": [
            {
                "name": "update_room",
                "path": "/rooms/{room_id}",
                "method": "PATCH",
                "parameters": [
                    {
                        "name": "room_id",
                        "location": "path",
                        "required": True,
                        "schema": {"type": "integer"},
                    }
                ],
                "body": {
                    "type": "object",
                    "properties": {"status": {"enum": ["available", "occupied"]}},
                },
            }
        ],
    }


def test_schema_v2_serializes_explicit_application_types() -> None:
    manifest = SchemaManifest(
        schema=SCHEMA_MANIFEST_V2,
        producer="0.8.0",
        fingerprint=FINGERPRINT,
        types={
            "User": TypeSchemaEntry(
                mode="serialization",
                schema={
                    "type": "object",
                    "properties": {"id": {"type": "integer"}},
                    "required": ["id"],
                },
            )
        },
    )

    assert manifest.model_dump(mode="json", by_alias=True, exclude_none=True) == {
        "schema": "fluxfast-schema/2",
        "producer": "0.8.0",
        "fingerprint": FINGERPRINT,
        "types": {
            "User": {
                "mode": "serialization",
                "schema": {
                    "type": "object",
                    "properties": {"id": {"type": "integer"}},
                    "required": ["id"],
                },
            }
        },
        "resources": {},
        "pages": [],
        "mutations": [],
    }


def test_schema_v1_rejects_explicit_application_types() -> None:
    with pytest.raises(ValidationError, match="cannot contain explicit type"):
        SchemaManifest(
            schema=SCHEMA_MANIFEST_VERSION,
            producer="0.7.0",
            fingerprint=FINGERPRINT,
            types={},
        )


def test_manifest_version_is_independent_from_browser_protocol() -> None:
    assert SCHEMA_MANIFEST_VERSION == "fluxfast-schema/1"
    assert SCHEMA_MANIFEST_VERSION != PROTOCOL_VERSION


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("schema", "fluxfast/1"),
        ("producer", "version-six"),
        ("fingerprint", "ABC123"),
    ],
)
def test_manifest_rejects_invalid_identity_fields(field: str, value: str) -> None:
    data = {
        "schema": SCHEMA_MANIFEST_VERSION,
        "producer": "0.6.0",
        "fingerprint": FINGERPRINT,
    }
    data[field] = value

    with pytest.raises(ValidationError):
        SchemaManifest.model_validate(data)


@pytest.mark.parametrize("key", ["", "rooms,summary", "rooms\nsecret", "x" * 129])
def test_manifest_rejects_invalid_resource_keys(key: str) -> None:
    with pytest.raises(ValidationError):
        SchemaManifest(
            schema=SCHEMA_MANIFEST_VERSION,
            producer="0.6.0",
            fingerprint=FINGERPRINT,
            resources={key: ResourceSchemaEntry(schema={})},
        )


def test_manifest_rejects_unknown_fields_and_non_json_schema_values() -> None:
    with pytest.raises(ValidationError, match="extra_forbidden"):
        SchemaManifest.model_validate(
            {
                "schema": SCHEMA_MANIFEST_VERSION,
                "producer": "0.6.0",
                "fingerprint": FINGERPRINT,
                "redisUrl": "redis://private-host",
            }
        )

    with pytest.raises(ValidationError, match="valid JSON value"):
        ResourceSchemaEntry(schema={"default": object()})

    with pytest.raises(ValidationError, match="non-finite"):
        ResourceSchemaEntry(schema={"default": math.inf})


def test_schema_values_enforce_depth_child_and_string_boundaries() -> None:
    nested: object = "leaf"
    for _ in range(65):
        nested = {"value": nested}
    with pytest.raises(ValidationError, match="nesting depth"):
        ResourceSchemaEntry(schema={"default": nested})

    with pytest.raises(ValidationError, match="more than 10000 properties"):
        ResourceSchemaEntry(
            schema={
                "properties": {
                    f"field-{index}": {} for index in range(10_001)
                }
            }
        )

    ResourceSchemaEntry(schema={"description": "x" * 65_536})
    with pytest.raises(ValidationError, match="longer than 65536"):
        ResourceSchemaEntry(schema={"description": "x" * 65_537})

    ResourceSchemaEntry(schema={"description": "😀" * 32_768})
    with pytest.raises(ValidationError, match="longer than 65536"):
        ResourceSchemaEntry(schema={"description": "😀" * 32_769})


@pytest.mark.parametrize(
    "schema",
    [
        {"const": 9_007_199_254_740_992},
        {"enum": [-9_007_199_254_740_992]},
        {"minimum": 9_007_199_254_740_992.0},
        {"maximum": 1e308},
        {"minimum": 10**5_000},
        {"metadata": {"value": -(10**5_000)}},
    ],
)
def test_schema_values_reject_integers_javascript_cannot_represent_safely(
    schema: dict[str, object],
) -> None:
    with pytest.raises(ValidationError, match="JavaScript safe integer range"):
        ResourceSchemaEntry(schema=schema)


def test_schema_values_accept_javascript_safe_integer_boundaries() -> None:
    ResourceSchemaEntry(
        schema={
            "minimum": -9_007_199_254_740_991,
            "maximum": 9_007_199_254_740_991,
        }
    )


def test_shared_python_manifest_boundary_fixture_is_valid() -> None:
    fixture = (
        Path(__file__).parents[3]
        / "tests"
        / "fixtures"
        / "python-manifest-boundaries.json"
    )
    type_name = "😀" * 64
    python_manifest = SchemaManifest(
        schema=SCHEMA_MANIFEST_V2,
        producer="0.8.0",
        fingerprint=FINGERPRINT,
        types={
            type_name: TypeSchemaEntry(
                mode="validation",
                schema={"minimum": 9_007_199_254_740_991},
            )
        },
    )
    fixture_value = json.loads(fixture.read_text(encoding="utf8"))

    assert fixture_value == python_manifest.model_dump(
        mode="json", by_alias=True, exclude_none=True
    )
    assert len(type_name.encode("utf-16-le")) // 2 == 128


def test_manifest_bounds_collections_and_aggregate_metadata() -> None:
    page = PageRouteSchema(name="page", path="/page")
    with pytest.raises(ValidationError, match="more than 10000 entries"):
        SchemaManifest(
            schema=SCHEMA_MANIFEST_VERSION,
            producer="0.7.0",
            fingerprint=FINGERPRINT,
            pages=[page] * 10_001,
        )

    large_page = PageRouteSchema(
        name="n" * 128,
        path=f"/{'p' * 2047}",
    )
    with pytest.raises(ValidationError, match="total string characters"):
        SchemaManifest(
            schema=SCHEMA_MANIFEST_VERSION,
            producer="0.7.0",
            fingerprint=FINGERPRINT,
            pages=[large_page] * 4_100,
        )


def test_manifest_counts_shared_aliases_as_serialized_contributions() -> None:
    shared_schema: dict[str, object] = {"description": "x" * 60_000}
    shared_resource = ResourceSchemaEntry(schema=shared_schema)

    with pytest.raises(ValidationError, match="total string characters"):
        SchemaManifest(
            schema=SCHEMA_MANIFEST_VERSION,
            producer="0.7.0",
            fingerprint=FINGERPRINT,
            resources={
                f"resource-{index}": shared_resource for index in range(140)
            },
        )


def test_route_descriptors_reject_unsafe_shapes() -> None:
    with pytest.raises(ValidationError, match="must be required"):
        RouteParameterSchema(
            name="room_id",
            location="path",
            required=False,
            schema={"type": "integer"},
        )
    with pytest.raises(ValidationError, match="route path"):
        PageRouteSchema(name="rooms", path="rooms")
    with pytest.raises(ValidationError, match="method"):
        MutationRouteSchema.model_validate(
            {"name": "upload", "path": "/upload", "method": "GET"}
        )


@pytest.mark.parametrize("control", ["\x00", "\x7f", "\x85"])
@pytest.mark.parametrize(
    "factory",
    [
        lambda control: SchemaManifest(
            schema=SCHEMA_MANIFEST_VERSION,
            producer="0.7.0",
            fingerprint=FINGERPRINT,
            resources={f"rooms{control}": ResourceSchemaEntry(schema={})},
        ),
        lambda control: PageRouteSchema(name=f"rooms{control}", path="/rooms"),
        lambda control: PageRouteSchema(name="rooms", path=f"/rooms{control}"),
        lambda control: RouteParameterSchema(
            name=f"room{control}id",
            location="query",
            required=False,
            schema={},
        ),
        lambda control: MutationRouteSchema(
            name=f"update{control}room",
            path="/rooms",
            method="POST",
        ),
        lambda control: MutationRouteSchema(
            name="update_room",
            path=f"/rooms{control}",
            method="POST",
        ),
    ],
)
def test_manifest_rejects_control_characters_across_names_and_paths(
    control: str,
    factory: Callable[[str], object],
) -> None:
    with pytest.raises(ValidationError, match="control characters"):
        factory(control)


def test_manifest_collection_defaults_are_not_shared() -> None:
    first = SchemaManifest(
        schema=SCHEMA_MANIFEST_VERSION,
        producer="0.6.0",
        fingerprint=FINGERPRINT,
    )
    second = SchemaManifest(
        schema=SCHEMA_MANIFEST_VERSION,
        producer="0.6.0",
        fingerprint=FINGERPRINT,
    )

    first.pages.append(PageRouteSchema(name="rooms", path="/rooms"))

    assert second.pages == []
    assert second.resources == {}
    assert second.mutations == []
