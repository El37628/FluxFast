"""Backend copied into the isolated live-resource consumer."""

import asyncio

from fastapi import FastAPI
from fluxfast import (
    FluxFast,
    Page,
    invalidate_resource,
    mutation,
    resource,
    scope,
)
from pydantic import BaseModel, Field, field_validator

app = FastAPI()
flux = FluxFast(app)
analytics_loads = 0
live_counter = 0
live_report = 0


class Analytics(BaseModel):
    """Deferred analytics contract exported from the isolated wheel."""

    revenue: int
    load: int


class CounterValue(BaseModel):
    """Blocking and deferred live counter wire value."""

    value: int


class IncrementInput(BaseModel):
    """Typed JSON mutation body used by the generated frontend helper."""

    amount: int = Field(ge=1, le=10)


class User(BaseModel):
    """Application contract consumed by non-page TypeScript modules."""

    id: int
    name: str
    email: str


class Address(BaseModel):
    """Nested reusable validation input."""

    city: str = Field(min_length=2, max_length=80)
    postcode: str = Field(min_length=3, max_length=12)


class RegistrationInput(BaseModel):
    """Client-validated form with one authoritative server-only rule."""

    name: str = Field(min_length=2, max_length=80)
    email: str = Field(min_length=5, max_length=120)
    address: Address

    @field_validator("email")
    @classmethod
    def reject_registered_email(cls, value: str) -> str:
        if value.casefold() == "taken@example.com":
            raise ValueError("Email is already registered")
        return value


ANALYTICS = flux.define_resource("analytics", Analytics)
LIVE_COUNTER = flux.define_resource("live-counter", CounterValue)
LIVE_REPORT = flux.define_resource("live-report", CounterValue)
flux.define_type("RegistrationInput", RegistrationInput, mode="validation")
flux.define_type("User", User)


async def load_analytics() -> dict[str, int]:
    global analytics_loads
    analytics_loads += 1
    current_load = analytics_loads
    await asyncio.sleep(1)
    return {"revenue": 120_000, "load": current_load}


async def load_live_counter() -> dict[str, int]:
    await asyncio.sleep(0.1)
    return {"value": live_counter}


async def load_live_report() -> dict[str, int]:
    await asyncio.sleep(0.35)
    return {"value": live_report}


@flux.page("/")
async def home() -> Page:
    return Page(
        component="home/index",
        resources=[
            resource(ANALYTICS, load_analytics, defer=True),
            resource(
                LIVE_COUNTER,
                load_live_counter,
                scope=scope.public(),
                live=True,
            ),
            resource(
                LIVE_REPORT,
                load_live_report,
                scope=scope.public(),
                defer=True,
                live=True,
            ),
        ],
    )


@flux.mutation("/increment")
async def increment(body: IncrementInput):
    global live_counter, live_report
    live_counter += body.amount
    live_report += body.amount
    return mutation(
        invalidates=[
            invalidate_resource("live-counter", scope=scope.public()),
            invalidate_resource("live-report", scope=scope.public()),
        ]
    )


@flux.mutation("/registrations")
async def register_user(body: RegistrationInput):
    return mutation()
