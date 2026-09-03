"""Tests for the versioned offline FluxFast schema manifest."""

from __future__ import annotations

import math

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
