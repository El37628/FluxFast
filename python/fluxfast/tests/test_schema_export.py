"""Tests for offline export of registered typed resource contracts."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, time
from decimal import Decimal
from enum import Enum
from typing import Generic, Literal, Optional, TypeVar, Union
from uuid import UUID

import pytest
from fastapi import Body, Depends, FastAPI, Query
from pydantic import BaseModel, Field, field_serializer

from fluxfast import FluxFast, FluxRouter, Page, resource, scope
from fluxfast.schema_export import build_app_schema_manifest, build_schema_manifest


class Booking(BaseModel):
    id: int
    created_at: datetime = Field(serialization_alias="createdAt")
    amount: Decimal
    status: Literal["confirmed", "cancelled"]

    @field_serializer("amount")
    def serialize_amount(self, value: Decimal) -> str:
        return f"{value:.2f}"


class Summary(BaseModel):
    total: int


class RoomStatus(str, Enum):
    AVAILABLE = "available"
    OCCUPIED = "occupied"


class UpdateRoom(BaseModel):
    status: RoomStatus
    note: str | None = Field(default=None, validation_alias="inputNote")


@dataclass(frozen=True)
class Coordinates:
    latitude: float
    longitude: float


class Address(BaseModel):
    city: str
    coordinates: Coordinates


ItemT = TypeVar("ItemT")


class PageResult(BaseModel, Generic[ItemT]):
    items: list[ItemT]
    total: int


class TreeNode(BaseModel):
    name: str
    children: list[TreeNode] = Field(default_factory=list)


class CustomWireValue(BaseModel):
    code: int

    @field_serializer("code")
    def serialize_code(self, value: int) -> str:
        return f"C-{value}"


class AdvancedContractPayload(BaseModel):
    integer: int
    floating: float
    enabled: bool
    label: str
    tuple_values: tuple[int, ...]
    mapping: dict[str, Address]
    tags: set[str]
    legacy_optional: Optional[int]  # noqa: UP045 - compatibility contract
    modern_optional: str | None
    legacy_union: Union[int, str]  # noqa: UP007 - compatibility contract
    modern_union: float | bool
    lifecycle: Literal["draft", "published"]
    status: RoomStatus
    timestamp: datetime
    day: date
    clock: time
    identifier: UUID
    amount: Decimal
    address: Address
    page: PageResult[Address]
    tree: TreeNode
    custom: CustomWireValue


def test_export_uses_pydantic_serialization_mode_wire_schema() -> None:
    flux = FluxFast(FastAPI())
    flux.define_resource("bookings", list[Booking])

    manifest = build_schema_manifest(flux.schema_registry, producer="0.6.0")
    schema = manifest.resources["bookings"].json_schema
    booking = schema["$defs"]["Booking"]

    assert manifest.schema_version == "fluxfast-schema/1"
    assert manifest.producer == "0.6.0"
    assert manifest.pages == []
    assert manifest.mutations == []
    assert schema["type"] == "array"
    assert schema["items"] == {"$ref": "#/$defs/Booking"}
    assert booking["properties"]["createdAt"]["format"] == "date-time"
    assert booking["properties"]["amount"]["type"] == "string"
    assert booking["properties"]["status"]["enum"] == ["confirmed", "cancelled"]
    assert "created_at" not in booking["properties"]


def test_export_covers_advanced_pydantic_contract_shapes() -> None:
    flux = FluxFast(FastAPI())
    flux.define_resource("advanced", AdvancedContractPayload)

    manifest = build_schema_manifest(flux.schema_registry, producer="0.6.0")
    schema = manifest.resources["advanced"].json_schema
    properties = schema["properties"]

    def resolve(reference: str) -> dict[str, object]:
        prefix = "#/$defs/"
        assert reference.startswith(prefix)
        return schema["$defs"][reference.removeprefix(prefix)]

    assert schema["type"] == "object"
    assert properties["integer"]["type"] == "integer"
    assert properties["floating"]["type"] == "number"
    assert properties["enabled"]["type"] == "boolean"
    assert properties["label"]["type"] == "string"

    assert properties["tuple_values"] == {
        "items": {"type": "integer"},
        "title": "Tuple Values",
        "type": "array",
    }
    assert properties["tags"]["type"] == "array"
    assert properties["tags"]["items"] == {"type": "string"}
    assert properties["tags"]["uniqueItems"] is True

    assert properties["legacy_optional"]["anyOf"] == [
        {"type": "integer"},
        {"type": "null"},
    ]
    assert properties["modern_optional"]["anyOf"] == [
        {"type": "string"},
        {"type": "null"},
    ]
    assert properties["legacy_union"]["anyOf"] == [
        {"type": "integer"},
        {"type": "string"},
    ]
    assert properties["modern_union"]["anyOf"] == [
        {"type": "number"},
        {"type": "boolean"},
    ]
    assert properties["lifecycle"]["enum"] == ["draft", "published"]

    assert resolve(properties["status"]["$ref"])["enum"] == [
        "available",
        "occupied",
    ]
    assert properties["timestamp"]["format"] == "date-time"
    assert properties["day"]["format"] == "date"
    assert properties["clock"]["format"] == "time"
    assert properties["identifier"]["format"] == "uuid"
    assert properties["amount"]["type"] == "string"

    address = resolve(properties["address"]["$ref"])
    coordinates = resolve(address["properties"]["coordinates"]["$ref"])
    assert address["properties"]["city"]["type"] == "string"
    assert coordinates["properties"]["latitude"]["type"] == "number"
    assert coordinates["properties"]["longitude"]["type"] == "number"
    assert resolve(properties["mapping"]["additionalProperties"]["$ref"]) == address

    page = resolve(properties["page"]["$ref"])
    assert page["title"] == "PageResult[Address]"
    assert resolve(page["properties"]["items"]["items"]["$ref"]) == address
    assert page["properties"]["total"]["type"] == "integer"

    tree_reference = properties["tree"]["$ref"]
    tree = resolve(tree_reference)
    assert tree["properties"]["name"]["type"] == "string"
    assert tree["properties"]["children"]["items"]["$ref"] == tree_reference

    custom = resolve(properties["custom"]["$ref"])
    assert custom["properties"]["code"]["type"] == "string"


def test_export_is_sorted_and_fingerprint_is_deterministic() -> None:
    first = FluxFast(FastAPI())
    first.define_resource("summary", Summary)
    first.define_resource("bookings", list[Booking])

    second = FluxFast(FastAPI())
    second.define_resource("bookings", list[Booking])
    second.define_resource("summary", Summary)

    first_manifest = build_schema_manifest(first.schema_registry, producer="0.6.0")
    same_manifest = build_schema_manifest(second.schema_registry, producer="0.6.0")
    other_producer = build_schema_manifest(second.schema_registry, producer="0.6.1")

    assert list(first_manifest.resources) == ["bookings", "summary"]
    assert first_manifest.resources == same_manifest.resources
    assert first_manifest.fingerprint == same_manifest.fingerprint
    assert len(first_manifest.fingerprint) == 64
    assert first_manifest.model_dump_json(by_alias=True) == same_manifest.model_dump_json(
        by_alias=True
    )
    assert first_manifest.fingerprint == other_producer.fingerprint
    assert first_manifest.model_dump_json(by_alias=True) != other_producer.model_dump_json(
        by_alias=True
    )


def test_contract_change_changes_manifest_fingerprint() -> None:
    first = FluxFast(FastAPI())
    first.define_resource("summary", Summary)

    second = FluxFast(FastAPI())
    second.define_resource("summary", list[Summary])

    first_manifest = build_schema_manifest(first.schema_registry, producer="0.6.0")
    second_manifest = build_schema_manifest(second.schema_registry, producer="0.6.0")

    assert first_manifest.fingerprint != second_manifest.fingerprint


def test_export_does_not_execute_pages_loaders_dependencies_or_runtime_scopes() -> None:
    app = FastAPI()
    flux = FluxFast(app)
    rooms = flux.define_resource("rooms", list[Summary])
    calls = {"page": 0, "loader": 0, "dependency": 0}

    def dependency() -> str:
        calls["dependency"] += 1
        return "private-user-id"

    def loader() -> list[dict[str, int]]:
        calls["loader"] += 1
        return [{"total": 42}]

    @flux.page("/rooms")
    async def rooms_page(user_id: str = Depends(dependency)) -> Page:
        calls["page"] += 1
        return Page(
            component="rooms/index",
            resources=[
                resource(
                    rooms,
                    loader,
                    scope=scope.tenant("private-tenant-id"),
                    ttl=60,
                )
            ],
            meta={"user": user_id},
        )

    manifest = build_schema_manifest(flux.schema_registry, producer="0.6.0")
    exported = manifest.model_dump_json(by_alias=True)

    assert calls == {"page": 0, "loader": 0, "dependency": 0}
    assert list(manifest.resources) == ["rooms"]
    assert "private-user-id" not in exported
    assert "private-tenant-id" not in exported
    assert "redis" not in exported.lower()
    assert all(route.path != "/.fluxfast/schema" for route in app.routes)


def test_export_uses_only_the_given_application_registry() -> None:
    first = FluxFast(FastAPI())
    first.define_resource("bookings", list[Booking])
    second = FluxFast(FastAPI())
    second.define_resource("summary", Summary)

    first_manifest = build_schema_manifest(first.schema_registry, producer="0.6.0")
    second_manifest = build_schema_manifest(second.schema_registry, producer="0.6.0")

    assert list(first_manifest.resources) == ["bookings"]
    assert list(second_manifest.resources) == ["summary"]


def test_app_export_includes_typed_page_path_query_and_dependency_parameters() -> None:
    app = FastAPI()
    flux = FluxFast(app)
    calls = {"page": 0, "dependency": 0}

    def filters_dependency(limit: int = 25) -> None:
        calls["dependency"] += 1

    @flux.page(
        "/hotels/{hotel_id}/rooms",
        name="hotel_rooms",
        include_in_schema=False,
    )
    async def hotel_rooms_page(
        hotel_id: int,
        page: int = 1,
        status: RoomStatus | None = None,
        search: str = Query(min_length=2),
        filters: None = Depends(filters_dependency),
    ) -> Page:
        calls["page"] += 1
        return Page(component="rooms/index", meta={"filters": filters})

    @app.get("/ordinary/{value}")
    async def ordinary_api(value: str) -> dict[str, str]:
        return {"value": value}

    manifest = build_app_schema_manifest(app, producer="0.6.0")

    assert calls == {"page": 0, "dependency": 0}
    assert [page.name for page in manifest.pages] == ["hotel_rooms"]
    page_route = manifest.pages[0]
    assert page_route.path == "/hotels/{hotel_id}/rooms"
    assert [
        (parameter.location, parameter.name, parameter.required)
        for parameter in page_route.parameters
    ] == [
        ("path", "hotel_id", True),
        ("query", "limit", False),
        ("query", "page", False),
        ("query", "search", True),
        ("query", "status", False),
    ]
    schemas = {
        parameter.name: parameter.json_schema for parameter in page_route.parameters
    }
    assert schemas["hotel_id"] == {"type": "integer"}
    assert schemas["page"] == {"default": 1, "type": "integer"}
    assert schemas["search"] == {"minLength": 2, "type": "string"}
    assert schemas["status"]["anyOf"][0]["$ref"] == "#/$defs/RoomStatus"
    assert schemas["status"]["$defs"]["RoomStatus"]["enum"] == [
        "available",
        "occupied",
    ]


def test_app_export_resolves_included_router_prefixes_and_sorts_pages() -> None:
    app = FastAPI()
    FluxFast(app)
    router = FluxRouter(prefix="/workspace")

    @router.page("/zeta", name="zeta")
    async def zeta_page() -> Page:
        return Page(component="zeta/index")

    @router.page("/alpha/{slug}", name="alpha")
    async def alpha_page(slug: str) -> Page:
        return Page(component="alpha/index")

    app.include_router(router, prefix="/api")

    manifest = build_app_schema_manifest(app, producer="0.6.0")

    assert [(page.name, page.path) for page in manifest.pages] == [
        ("alpha", "/api/workspace/alpha/{slug}"),
        ("zeta", "/api/workspace/zeta"),
    ]


def test_page_metadata_changes_manifest_fingerprint() -> None:
    first_app = FastAPI()
    first = FluxFast(first_app)

    @first.page("/rooms/{room_id}", name="rooms")
    async def first_rooms(room_id: int) -> Page:
        return Page(component="rooms/index", meta={"room": room_id})

    second_app = FastAPI()
    second = FluxFast(second_app)

    @second.page("/rooms/{room_id}", name="rooms")
    async def second_rooms(room_id: str) -> Page:
        return Page(component="rooms/index", meta={"room": room_id})

    first_manifest = build_app_schema_manifest(first_app, producer="0.6.0")
    second_manifest = build_app_schema_manifest(second_app, producer="0.6.0")

    assert first_manifest.fingerprint != second_manifest.fingerprint


def test_app_export_includes_typed_json_mutation_metadata_without_execution() -> None:
    app = FastAPI()
    flux = FluxFast(app)
    calls = {"mutation": 0, "dependency": 0}

    def filters_dependency(dry_run: bool = False) -> None:
        calls["dependency"] += 1

    @flux.mutation(
        "/rooms/{room_id}",
        methods=["PATCH"],
        name="update_room",
        include_in_schema=False,
    )
    async def update_room(
        room_id: int,
        payload: UpdateRoom,
        notify: bool = True,
        filters: None = Depends(filters_dependency),
    ) -> dict[str, bool]:
        calls["mutation"] += 1
        return {"ok": True}

    manifest = build_app_schema_manifest(app, producer="0.6.0")

    assert calls == {"mutation": 0, "dependency": 0}
    assert len(manifest.mutations) == 1
    mutation = manifest.mutations[0]
    assert (mutation.name, mutation.path, mutation.method) == (
        "update_room",
        "/rooms/{room_id}",
        "PATCH",
    )
    assert [
        (parameter.location, parameter.name, parameter.required)
        for parameter in mutation.parameters
    ] == [
        ("path", "room_id", True),
        ("query", "dry_run", False),
        ("query", "notify", False),
    ]
    assert mutation.body_schema is not None
    assert mutation.body_schema["type"] == "object"
    assert mutation.body_schema["required"] == ["status"]
    assert "inputNote" in mutation.body_schema["properties"]
    assert "note" not in mutation.body_schema["properties"]


def test_app_export_splits_multi_method_mutations_and_resolves_router_prefixes() -> None:
    app = FastAPI()
    FluxFast(app)
    router = FluxRouter(prefix="/workspace")

    @router.mutation(
        "/rooms/{room_id}",
        methods=["PUT", "PATCH", "POST"],
        name="save_room",
    )
    async def save_room(room_id: int, payload: UpdateRoom) -> dict[str, int]:
        return {"room_id": room_id}

    app.include_router(router, prefix="/api")

    manifest = build_app_schema_manifest(app, producer="0.6.0")

    assert [
        (mutation.name, mutation.path, mutation.method)
        for mutation in manifest.mutations
    ] == [
        ("save_room", "/api/workspace/rooms/{room_id}", "PATCH"),
        ("save_room", "/api/workspace/rooms/{room_id}", "POST"),
        ("save_room", "/api/workspace/rooms/{room_id}", "PUT"),
    ]


def test_app_export_omits_non_json_mutation_body_metadata() -> None:
    app = FastAPI()
    flux = FluxFast(app)

    @flux.mutation("/notes", name="save_note")
    async def save_note(
        note: str = Body(media_type="text/plain"),
    ) -> dict[str, str]:
        return {"note": note}

    manifest = build_app_schema_manifest(app, producer="0.6.0")

    assert len(manifest.mutations) == 1
    assert manifest.mutations[0].body_schema is None


def test_app_export_uses_fastapi_combined_json_body_shape() -> None:
    app = FastAPI()
    flux = FluxFast(app)

    @flux.mutation("/rooms", name="create_room")
    async def create_room(
        number: int = Body(),
        status: RoomStatus = Body(),
    ) -> dict[str, int]:
        return {"number": number}

    manifest = build_app_schema_manifest(app, producer="0.6.0")

    body = manifest.mutations[0].body_schema
    assert body is not None
    assert body["type"] == "object"
    assert body["required"] == ["number", "status"]
    assert body["properties"]["number"] == {"title": "Number", "type": "integer"}
    assert body["properties"]["status"]["$ref"] == "#/$defs/RoomStatus"


def test_mutation_metadata_changes_manifest_fingerprint() -> None:
    first_app = FastAPI()
    first = FluxFast(first_app)

    @first.mutation("/rooms/{room_id}", methods=["PATCH"], name="update_room")
    async def first_update(room_id: int, payload: UpdateRoom) -> dict[str, int]:
        return {"room_id": room_id}

    second_app = FastAPI()
    second = FluxFast(second_app)

    @second.mutation("/rooms/{room_id}", methods=["PUT"], name="update_room")
    async def second_update(room_id: int, payload: UpdateRoom) -> dict[str, int]:
        return {"room_id": room_id}

    first_manifest = build_app_schema_manifest(first_app, producer="0.6.0")
    second_manifest = build_app_schema_manifest(second_app, producer="0.6.0")

    assert first_manifest.fingerprint != second_manifest.fingerprint


def test_app_export_requires_fluxfast_integration() -> None:
    with pytest.raises(TypeError, match="not configured with FluxFast"):
        build_app_schema_manifest(FastAPI(), producer="0.6.0")
