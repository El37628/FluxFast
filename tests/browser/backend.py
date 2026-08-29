"""FastAPI application used by the repository-owned browser tests."""

from fastapi import FastAPI
from fluxfast import (
    FluxFast,
    Page,
    append_item,
    flux_redirect,
    mutation,
    resource,
    scope,
)
from pydantic import BaseModel, Field

app = FastAPI()
flux = FluxFast(app)

rooms = [{"id": 1, "name": "Garden Suite"}]


class RoomInput(BaseModel):
    """Validated payload used to exercise browser-side form errors."""

    name: str = Field(min_length=2, max_length=80)


def application_details() -> dict[str, str]:
    return {"name": "FluxFast Browser Fixture"}


def current_rooms() -> list[dict[str, object]]:
    return [dict(room) for room in rooms]


@flux.page("/")
async def home() -> Page:
    return Page(
        component="home/index",
        resources=[
            resource(
                "application",
                application_details,
                scope=scope.public(),
                ttl=60,
            )
        ],
    )


@flux.page("/rooms")
async def room_index() -> Page:
    return Page(
        component="rooms/index",
        resources=[
            resource(
                "application",
                application_details,
                scope=scope.public(),
                ttl=60,
            ),
            resource("rooms", current_rooms),
        ],
    )


@flux.mutation("/rooms")
async def add_room(payload: RoomInput):
    room = {"id": len(rooms) + 1, "name": payload.name}
    rooms.append(room)
    return mutation(patch={"rooms": append_item(room)})


@flux.mutation("/rooms/finish")
async def finish_rooms():
    return flux_redirect("/")
