"""Compatibility freeze tests for the fluxfast-schema/2 developer manifest."""

from __future__ import annotations

import json
from decimal import Decimal
from pathlib import Path
from typing import Any

import pytest
from fastapi import FastAPI, Query
from pydantic import BaseModel, Field

from fluxfast import ContractMode, FluxFast, Page
from fluxfast.schema_export import build_app_schema_manifest, build_schema_manifest
from fluxfast.schema_manifest import (
    SCHEMA_MANIFEST_V2,
    MutationRouteSchema,
    PageRouteSchema,
    ResourceSchemaEntry,
    RouteParameterSchema,
    SchemaManifest,
    TypeSchemaEntry,
)
from fluxfast.schema_registry import SchemaRegistry

FIXTURE_ROOT = Path(__file__).parents[3] / "tests" / "fixtures" / "schema"


class User(BaseModel):
    id: int
    display_name: str = Field(serialization_alias="displayName")


class Room(BaseModel):
    id: int
    nightly_rate: Decimal = Field(serialization_alias="nightlyRate")


class CreateRoomInput(BaseModel):
    name: str = Field(
        min_length=2,
        validation_alias="inputName",
        serialization_alias="outputName",
    )


class AlternateRoomInput(BaseModel):
    label: str


def _build_frozen_manifest(
    *,
    type_mode: ContractMode = "serialization",
    resource_annotation: Any = list[Room],
    page_rate_annotation: Any = Decimal,
    mutation_method: str = "PATCH",
    body_annotation: Any = CreateRoomInput,
    producer: str = "0.9.0",
):
    app = FastAPI()
    flux = FluxFast(app)
    flux.define_type("User", User, mode=type_mode)
    flux.define_type("CreateRoomInput", CreateRoomInput, mode="validation")
    flux.define_resource("rooms", resource_annotation)

    async def decimal_hotel_rooms(
        hotel_id: int,
        minimum_rate: Decimal = Query(alias="minimumRate"),
    ) -> Page:
        return Page(component="rooms/index", meta={"hotel_id": hotel_id})

    async def integer_hotel_rooms(
        hotel_id: int,
        minimum_rate: int = Query(alias="minimumRate"),
    ) -> Page:
        return Page(component="rooms/index", meta={"hotel_id": hotel_id})

    page_handler = (
        decimal_hotel_rooms
        if page_rate_annotation is Decimal
        else integer_hotel_rooms
    )
    flux.page("/hotels/{hotel_id}/rooms", name="hotel_rooms")(page_handler)

    async def create_room_input_update(
        room_id: int,
        payload: CreateRoomInput,
        budget: Decimal = Query(alias="budget"),
    ) -> dict[str, int]:
        return {"room_id": room_id}

    async def alternate_room_input_update(
        room_id: int,
        payload: AlternateRoomInput,
        budget: Decimal = Query(alias="budget"),
    ) -> dict[str, int]:
        return {"room_id": room_id}

    mutation_handler = (
        create_room_input_update
        if body_annotation is CreateRoomInput
        else alternate_room_input_update
    )
    flux.mutation(
        "/rooms/{room_id}",
        methods=[mutation_method],
        name="update_room",
    )(mutation_handler)

    return build_app_schema_manifest(app, producer=producer)


def test_schema_v2_producer_matches_shared_golden_fixture() -> None:
    fixture = json.loads(
        (FIXTURE_ROOT / "fluxfast-schema-v2.json").read_text(encoding="utf8")
    )
    manifest = _build_frozen_manifest()

    assert manifest.schema_version == SCHEMA_MANIFEST_V2
    assert manifest.model_dump(mode="json", by_alias=True, exclude_none=True) == fixture


def test_schema_v2_model_field_inventory_is_closed() -> None:
    assert tuple(SchemaManifest.model_fields) == (
        "schema_version",
        "producer",
        "fingerprint",
        "types",
        "resources",
        "pages",
        "mutations",
    )
    assert tuple(TypeSchemaEntry.model_fields) == ("mode", "json_schema")
    assert tuple(ResourceSchemaEntry.model_fields) == ("json_schema",)
    assert tuple(PageRouteSchema.model_fields) == ("name", "path", "parameters")
    assert tuple(RouteParameterSchema.model_fields) == (
        "name",
        "location",
        "required",
        "json_schema",
    )
    assert tuple(MutationRouteSchema.model_fields) == (
        "name",
        "path",
        "method",
        "parameters",
        "body_schema",
    )


def test_current_producer_emits_schema_v2_for_an_empty_registry() -> None:
    manifest = build_schema_manifest(SchemaRegistry(), producer="0.9.0")

    assert manifest.schema_version == SCHEMA_MANIFEST_V2
    assert manifest.types == {}


def test_schema_v2_fingerprint_is_order_independent_where_promised() -> None:
    first = SchemaRegistry()
    first.define_resource("rooms", list[Room])
    first.define_resource("users", list[User])
    first.define_type("User", User)
    first.define_type("CreateRoomInput", CreateRoomInput, mode="validation")

    second = SchemaRegistry()
    second.define_type("CreateRoomInput", CreateRoomInput, mode="validation")
    second.define_type("User", User)
    second.define_resource("users", list[User])
    second.define_resource("rooms", list[Room])

    pages = [
        PageRouteSchema(name="users", path="/users"),
        PageRouteSchema(
            name="rooms",
            path="/rooms/{room_id}",
            parameters=[
                RouteParameterSchema(
                    name="room_id",
                    location="path",
                    required=True,
                    schema={"type": "integer"},
                )
            ],
        ),
    ]
    mutations = [
        MutationRouteSchema(
            name="delete_room",
            path="/rooms/{room_id}",
            method="DELETE",
        ),
        MutationRouteSchema(name="create_room", path="/rooms", method="POST"),
    ]

    first_manifest = build_schema_manifest(
        first,
        producer="0.9.0",
        pages=pages,
        mutations=mutations,
    )
    second_manifest = build_schema_manifest(
        second,
        producer="0.9.1",
        pages=reversed(pages),
        mutations=reversed(mutations),
    )

    assert first_manifest.fingerprint == second_manifest.fingerprint
    assert first_manifest.model_dump(mode="json", by_alias=True)["producer"] != (
        second_manifest.model_dump(mode="json", by_alias=True)["producer"]
    )


@pytest.mark.parametrize(
    "change",
    [
        {"type_mode": "validation"},
        {"resource_annotation": list[int]},
        {"page_rate_annotation": int},
        {"mutation_method": "PUT"},
        {"body_annotation": AlternateRoomInput},
    ],
)
def test_schema_v2_fingerprint_changes_with_every_semantic_surface(
    change: dict[str, Any],
) -> None:
    baseline = _build_frozen_manifest()
    changed = _build_frozen_manifest(**change)

    assert changed.fingerprint != baseline.fingerprint


def test_schema_v2_fingerprint_ignores_machine_path_time_and_producer(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    first_directory = tmp_path / "first"
    second_directory = tmp_path / "second"
    first_directory.mkdir()
    second_directory.mkdir()

    monkeypatch.chdir(first_directory)
    monkeypatch.setenv("SOURCE_DATE_EPOCH", "0")
    first = _build_frozen_manifest()

    monkeypatch.chdir(second_directory)
    monkeypatch.setenv("SOURCE_DATE_EPOCH", "4102444800")
    second = _build_frozen_manifest(producer="0.9.1")

    assert first.fingerprint == second.fingerprint
    serialized = first.model_dump_json(by_alias=True, exclude_none=True)
    assert str(first_directory) not in serialized
    assert str(second_directory) not in serialized
    assert "SOURCE_DATE_EPOCH" not in serialized
