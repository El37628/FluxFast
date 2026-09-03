"""Tests for explicit, application-scoped resource contracts."""

from dataclasses import FrozenInstanceError
from types import MappingProxyType
from typing import Literal

import pytest
from fastapi import FastAPI
from pydantic import BaseModel, PydanticSchemaGenerationError

from fluxfast import FluxFast, ResourceContract, TypeContract


class Room(BaseModel):
    id: int
    status: Literal["available", "occupied"]


class Summary(BaseModel):
    occupied: int


def test_define_resource_registers_a_frozen_typed_contract() -> None:
    app = FastAPI()
    flux = FluxFast(app)

    rooms = flux.define_resource("rooms", list[Room])

    assert isinstance(rooms, ResourceContract)
    assert rooms.key == "rooms"
    assert rooms.annotation == list[Room]
    assert flux.schema_registry.resource_contracts == {"rooms": rooms}
    assert app.state.fluxfast_schema_registry is flux.schema_registry
    with pytest.raises(FrozenInstanceError):
        rooms.key = "other"  # type: ignore[misc]


def test_schema_registry_exposes_a_live_read_only_contract_view() -> None:
    flux = FluxFast(FastAPI())
    contracts = flux.schema_registry.resource_contracts

    assert isinstance(contracts, MappingProxyType)
    assert contracts == {}

    summary = flux.define_resource("summary", Summary)
    assert contracts == {"summary": summary}
    with pytest.raises(TypeError):
        contracts["other"] = summary  # type: ignore[index]


def test_resource_contracts_are_scoped_to_each_fluxfast_instance() -> None:
    first = FluxFast(FastAPI())
    second = FluxFast(FastAPI())

    first_rooms = first.define_resource("rooms", list[Room])
    second_rooms = second.define_resource("rooms", dict[str, Room])

    assert first.schema_registry is not second.schema_registry
    assert first.schema_registry.resource_contracts == {"rooms": first_rooms}
    assert second.schema_registry.resource_contracts == {"rooms": second_rooms}


def test_duplicate_resource_contract_is_rejected_without_replacing_original() -> None:
    flux = FluxFast(FastAPI())
    original = flux.define_resource("rooms", list[Room])

    with pytest.raises(
        ValueError, match='resource contract "rooms" is already defined'
    ):
        flux.define_resource("rooms", Summary)

    assert flux.schema_registry.resource_contracts == {"rooms": original}


@pytest.mark.parametrize(
    ("key", "message"),
    [
        ("", "non-empty string"),
        (" ", "non-empty string"),
        ("x" * 129, "at most 128"),
        ("😀" * 65, "at most 128"),
        ("rooms,summary", "commas"),
        ("rooms\n", "control characters"),
        ("rooms\x7f", "control characters"),
        ("rooms\x85", "control characters"),
    ],
)
def test_define_resource_reuses_logical_key_validation(key: str, message: str) -> None:
    flux = FluxFast(FastAPI())

    with pytest.raises(ValueError, match=message):
        flux.define_resource(key, Room)

    assert flux.schema_registry.resource_contracts == {}


def test_define_resource_rejects_unsupported_annotations_without_registration() -> None:
    flux = FluxFast(FastAPI())

    with pytest.raises(PydanticSchemaGenerationError):
        flux.define_resource("rooms", 123)  # type: ignore[arg-type]

    assert flux.schema_registry.resource_contracts == {}


def test_define_type_registers_a_frozen_application_contract() -> None:
    app = FastAPI()
    flux = FluxFast(app)

    user = flux.define_type("User", Room)

    assert isinstance(user, TypeContract)
    assert user.name == "User"
    assert user.annotation is Room
    assert user.mode == "serialization"
    assert flux.schema_registry.type_contracts == {"User": user}
    with pytest.raises(FrozenInstanceError):
        user.name = "Other"  # type: ignore[misc]


def test_type_contracts_are_scoped_and_read_only() -> None:
    first = FluxFast(FastAPI())
    second = FluxFast(FastAPI())

    first_user = first.define_type("User", Room)
    second_user = second.define_type("User", Summary, mode="validation")

    assert first.schema_registry is not second.schema_registry
    assert first.schema_registry.type_contracts == {"User": first_user}
    assert second.schema_registry.type_contracts == {"User": second_user}
    with pytest.raises(TypeError):
        first.schema_registry.type_contracts["Other"] = first_user  # type: ignore[index]


def test_duplicate_type_contract_is_rejected_without_replacing_original() -> None:
    flux = FluxFast(FastAPI())
    original = flux.define_type("User", Room)

    with pytest.raises(ValueError, match='type contract "User" is already defined'):
        flux.define_type("User", Summary)

    assert flux.schema_registry.type_contracts == {"User": original}


@pytest.mark.parametrize(
    ("name", "message"),
    [
        ("", "non-empty string"),
        (" " , "non-empty string"),
        ("x" * 129, "at most 128"),
        ("😀" * 65, "at most 128"),
        ("User\n", "control characters"),
        ("User\x7f", "control characters"),
        ("User\x85", "control characters"),
    ],
)
def test_define_type_validates_names(name: str, message: str) -> None:
    flux = FluxFast(FastAPI())

    with pytest.raises(ValueError, match=message):
        flux.define_type(name, Room)

    assert flux.schema_registry.type_contracts == {}


def test_define_type_validates_mode_and_annotation_before_registration() -> None:
    flux = FluxFast(FastAPI())

    with pytest.raises(ValueError, match="contract mode"):
        flux.define_type("User", Room, mode="both")  # type: ignore[arg-type]
    with pytest.raises(PydanticSchemaGenerationError):
        flux.define_type("Broken", 123)

    assert flux.schema_registry.type_contracts == {}
