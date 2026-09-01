"""Tests for offline export of registered typed resource contracts."""

from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from typing import Literal

from fastapi import Depends, FastAPI
from pydantic import BaseModel, Field, field_serializer

from fluxfast import FluxFast, Page, resource, scope
from fluxfast.schema_export import build_schema_manifest


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
