"""Runtime validation and serialization tests for typed resources."""

from __future__ import annotations

from datetime import UTC, date, datetime, time
from decimal import Decimal
from enum import Enum
from typing import Literal
from uuid import UUID

import pytest
from fastapi import FastAPI
from pydantic import BaseModel, Field, field_serializer

from fluxfast import FluxFast, MemoryResourceCache, Page, resource, scope
from fluxfast.engine import ResourceEngine
from fluxfast.errors import ResourceError
from fluxfast.serialization import compute_version
from fluxfast.timing import TimingMetrics


class RoomStatus(str, Enum):
    AVAILABLE = "available"
    OCCUPIED = "occupied"


class Room(BaseModel):
    id: int
    number: str
    status: Literal["available", "occupied"]


class Booking(BaseModel):
    id: UUID
    created_at: datetime = Field(serialization_alias="createdAt")
    arrival: date
    wake_up: time
    amount: Decimal
    status: RoomStatus
    tags: set[str]

    @field_serializer("amount")
    def serialize_amount(self, value: Decimal) -> str:
        return f"{value:.2f}"


class CollectionShape(BaseModel):
    ordered: list[str]
    unordered: set[str]
    nested: dict[str, set[int]]


async def resolve(
    page: Page,
    cache: MemoryResourceCache | None = None,
    *,
    only_keys: set[str] | None = None,
    client_supports_deferred: bool = False,
    debug: bool = False,
):
    return await ResourceEngine.resolve_page_resources(
        page=page,
        known_versions={},
        only_keys=only_keys,
        cache=cache if cache is not None else MemoryResourceCache(),
        metrics=TimingMetrics(),
        client_supports_deferred=client_supports_deferred,
        debug=debug,
    )


@pytest.mark.anyio
async def test_typed_loader_is_validated_and_serialized_to_wire_shape() -> None:
    flux = FluxFast(FastAPI())
    bookings = flux.define_resource("bookings", list[Booking])
    booking_id = UUID("12345678-1234-5678-1234-567812345678")
    created_at = datetime(2026, 9, 1, 12, 30, tzinfo=UTC)
    page = Page(
        component="bookings/index",
        resources=[
            resource(
                bookings,
                lambda: [
                    {
                        "id": booking_id,
                        "created_at": created_at,
                        "arrival": date(2026, 9, 2),
                        "wake_up": time(7, 15),
                        "amount": Decimal("19.5"),
                        "status": RoomStatus.AVAILABLE,
                        "tags": {"priority", "direct"},
                    }
                ],
            )
        ],
    )

    resolution = await resolve(page)
    value = resolution.resources["bookings"].value

    assert value == [
        {
            "id": str(booking_id),
            "createdAt": "2026-09-01T12:30:00Z",
            "arrival": "2026-09-02",
            "wake_up": "07:15:00",
            "amount": "19.50",
            "status": "available",
            "tags": ["direct", "priority"],
        }
    ]
    assert resolution.resources["bookings"].version == compute_version(value)


@pytest.mark.anyio
async def test_typed_serialization_sorts_sets_without_reordering_lists() -> None:
    flux = FluxFast(FastAPI())
    collections = flux.define_resource("collections", CollectionShape)
    page = Page(
        component="collections/index",
        resources=[
            resource(
                collections,
                lambda: {
                    "ordered": ["z", "a"],
                    "unordered": {"z", "a"},
                    "nested": {"numbers": {3, 2, 1}},
                },
            )
        ],
    )

    resolution = await resolve(page)

    assert resolution.resources["collections"].value == {
        "ordered": ["z", "a"],
        "unordered": ["a", "z"],
        "nested": {"numbers": [1, 2, 3]},
    }


@pytest.mark.anyio
async def test_typed_validation_precedes_versioning_and_cache_storage() -> None:
    flux = FluxFast(FastAPI())
    rooms = flux.define_resource("rooms", list[Room])
    calls = 0

    def load_rooms():
        nonlocal calls
        calls += 1
        return [{"id": "1", "number": "101", "status": "available"}]

    spec = resource(rooms, load_rooms, scope=scope.public(), ttl=60)
    page = Page(component="rooms/index", resources=[spec])
    cache = MemoryResourceCache()

    first = await resolve(page, cache)
    cached = await cache.get(ResourceEngine.get_cache_key(spec))
    second = await resolve(page, cache)
    expected = [{"id": 1, "number": "101", "status": "available"}]

    assert calls == 1
    assert first.resources["rooms"].value == expected
    assert first.resources["rooms"].version == compute_version(expected)
    assert cached is not None
    assert cached.value == expected
    assert cached.version == compute_version(expected)
    assert second.resources["rooms"].value == expected
    assert second.resources["rooms"].version == cached.version


@pytest.mark.anyio
async def test_invalid_typed_loader_output_fails_resource_resolution() -> None:
    flux = FluxFast(FastAPI())
    rooms = flux.define_resource("rooms", list[Room])
    page = Page(
        component="rooms/index",
        resources=[
            resource(
                rooms,
                lambda: [
                    {"id": "not-an-int", "number": "101", "status": "available"}
                ],
            )
        ],
    )

    with pytest.raises(ResourceError, match="Error loading resource 'rooms'"):
        await resolve(page)


@pytest.mark.anyio
async def test_untyped_resource_keeps_existing_permissive_serialization() -> None:
    page = Page(
        component="rooms/index",
        resources=[
            resource(
                "rooms",
                lambda: [
                    {"id": "not-an-int", "number": "101", "status": "unexpected"}
                ],
            )
        ],
    )

    resolution = await resolve(page)

    assert resolution.resources["rooms"].value == [
        {"id": "not-an-int", "number": "101", "status": "unexpected"}
    ]


@pytest.mark.anyio
async def test_typed_deferred_follow_up_uses_contract_validation() -> None:
    flux = FluxFast(FastAPI())
    rooms = flux.define_resource("rooms", list[Room])
    page = Page(
        component="rooms/index",
        resources=[
            resource(
                rooms,
                lambda: [{"id": "bad", "number": "101", "status": "available"}],
                defer=True,
            )
        ],
    )

    initial = await resolve(page, client_supports_deferred=True)
    follow_up = await resolve(
        page,
        only_keys={"rooms"},
        client_supports_deferred=True,
    )

    assert initial.deferred == ["rooms"]
    assert follow_up.resources == {}
    assert follow_up.errors["rooms"].model_dump() == {
        "type": "ResourceError",
        "message": "A deferred resource could not be resolved",
        "details": None,
    }
