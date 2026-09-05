"""Regression coverage for authoritative FastAPI validation errors."""

from __future__ import annotations

from typing import Annotated, Literal, Self

import pytest
from fastapi import FastAPI
from fastapi.exceptions import RequestValidationError
from fastapi.testclient import TestClient
from pydantic import BaseModel, Field, field_validator, model_validator

from fluxfast import FluxFast
from fluxfast._validation_locations import _normalize_validation_location
from fluxfast.headers import HEADER_FLUXFAST


class Address(BaseModel):
    postcode: str


class User(BaseModel):
    email: str


class Group(BaseModel):
    users: list[User]


class NestedPayload(BaseModel):
    email: str
    address: Address
    addresses: list[Address]
    groups: list[Group]


class InvalidWindow(BaseModel):
    start: int
    end: int

    @model_validator(mode="after")
    def validate_window(self) -> Self:
        if self.end <= self.start:
            raise ValueError("end must be greater than start")
        return self


class Cat(BaseModel):
    kind: Literal["cat"]
    lives: int

    @field_validator("lives")
    @classmethod
    def validate_lives(cls, value: int) -> int:
        if value == 13:
            raise ValueError("Thirteen lives is not supported")
        return value


class Dog(BaseModel):
    kind: Literal["dog"]
    bark_volume: int


class DiscriminatedUnionPayload(BaseModel):
    pet: Annotated[Cat | Dog, Field(discriminator="kind")]


class OrdinaryUnionPayload(BaseModel):
    choice: int | bool


def _validation_app(*, integrate_fluxfast: bool = True) -> FastAPI:
    app = FastAPI()
    if integrate_fluxfast:
        FluxFast(app)

    @app.post("/hotels/{hotel_id}/validate")
    async def validate_nested_payload(
        payload: NestedPayload,
        hotel_id: int,
        page: int,
    ) -> None:
        pass

    @app.post("/window")
    async def validate_window(payload: InvalidWindow) -> None:
        pass

    @app.post("/discriminated-union")
    async def validate_discriminated_union(
        payload: DiscriminatedUnionPayload,
    ) -> None:
        pass

    @app.post("/ordinary-union")
    async def validate_ordinary_union(payload: OrdinaryUnionPayload) -> None:
        pass

    return app


def _synthetic_validation_app(
    errors: list[dict[str, object]],
    *,
    body: object = None,
) -> FastAPI:
    app = FastAPI()
    FluxFast(app)

    @app.get("/invalid")
    async def invalid() -> None:
        raise RequestValidationError(errors, body=body)

    return app


def _error(location: object, message: object) -> dict[str, object]:
    return {
        "type": "value_error",
        "loc": location,
        "msg": message,
        "input": None,
    }


@pytest.mark.parametrize(
    ("location", "expected"),
    [
        (("body", "email"), "email"),
        (("body", "address", "postcode"), "address.postcode"),
        (("body", "addresses", 0, "postcode"), "addresses[0].postcode"),
        (
            ("body", "groups", 0, "users", 2, "email"),
            "groups[0].users[2].email",
        ),
        (("query", "page"), "page"),
        (("path", "hotel_id"), "hotel_id"),
        (("header", "x-request-id"), '["x-request-id"]'),
        (("cookie", "session_id"), "session_id"),
        (("body", "matrix", 0, 1), "matrix[0][1]"),
        (("body", 0), "[0]"),
    ],
)
def test_location_normalizer_preserves_canonical_nested_paths(
    location: object,
    expected: str,
) -> None:
    assert _normalize_validation_location(location) == expected


def test_location_normalizer_strips_only_a_recognized_first_prefix() -> None:
    assert _normalize_validation_location(("form", "email")) == "form.email"
    assert _normalize_validation_location(("body", "query", "page")) == "query.page"
    assert _normalize_validation_location(("BODY", "email")) == "BODY.email"


@pytest.mark.parametrize("location", [(), [], None, "body", ("body",)])
def test_location_normalizer_uses_a_stable_root_fallback(location: object) -> None:
    assert _normalize_validation_location(location) == "general"


def test_location_normalizer_formats_hostile_names_as_data() -> None:
    very_long_name = f'{"x" * 10_000} unsafe'
    expected = {
        "__proto__": "__proto__",
        "constructor": "constructor",
        "prototype": "prototype",
        "a.b": '["a.b"]',
        "a[b]": '["a[b]"]',
        'quote"key': '["quote\\"key"]',
        "single'quote": "[\"single'quote\"]",
        "back\\slash": '["back\\\\slash"]',
        "line\nbreak": '["line\\nbreak"]',
        "null\0byte": '["null\\u0000byte"]',
        "surrogate\ud800key": '["surrogate\\ud800key"]',
        "0": '["0"]',
        "$": '["$"]',
        "café": '["café"]',
        very_long_name: f'["{very_long_name}"]',
    }

    assert {
        name: _normalize_validation_location(("body", name)) for name in expected
    } == expected


def test_location_normalizer_rejects_unexpected_shapes_without_stringifying() -> None:
    class HostileValue:
        def __str__(self) -> str:
            raise AssertionError("unexpected __str__ call")

        def __repr__(self) -> str:
            raise AssertionError("unexpected __repr__ call")

        def __iter__(self):
            raise AssertionError("unexpected __iter__ call")

    hostile = HostileValue()

    assert _normalize_validation_location(hostile) == "general"
    generator_location = (value for value in ("body", "email"))
    assert _normalize_validation_location(generator_location) == "general"
    assert _normalize_validation_location(("body", hostile)) == "general"
    assert _normalize_validation_location(("body", True)) == "general"
    assert _normalize_validation_location(("body", 1.5)) == "general"
    assert _normalize_validation_location(("body", b"email")) == "general"


def test_location_normalizer_quotes_unsafe_names_at_every_depth() -> None:
    assert _normalize_validation_location(
        ("body", "groups", 0, "unsafe.key", 'quote"key')
    ) == 'groups[0]["unsafe.key"]["quote\\"key"]'


def test_fluxfast_handler_preserves_real_fastapi_validation_locations() -> None:
    response = TestClient(_validation_app()).post(
        "/hotels/not-an-integer/validate?page=also-not-an-integer",
        json={
            "address": {},
            "addresses": [{}],
            "groups": {
                "not": "a list",
            },
        },
        headers={HEADER_FLUXFAST: "1"},
    )

    assert response.status_code == 422
    details = response.json()["error"]["details"]
    assert set(details) == {
        "email",
        "address.postcode",
        "addresses[0].postcode",
        "groups",
        "page",
        "hotel_id",
    }
    assert all(isinstance(key, str) for key in details)
    assert all(
        isinstance(messages, list)
        and messages
        and all(isinstance(message, str) for message in messages)
        for messages in details.values()
    )


def test_fluxfast_handler_preserves_deeply_nested_array_location() -> None:
    response = TestClient(_validation_app()).post(
        "/hotels/7/validate?page=1",
        json={
            "email": "person@example.com",
            "address": {"postcode": "12345"},
            "addresses": [{"postcode": "12345"}],
            "groups": [
                {
                    "users": [
                        {"email": "first@example.com"},
                        {"email": "second@example.com"},
                        {},
                    ]
                }
            ],
        },
        headers={HEADER_FLUXFAST: "1"},
    )

    assert response.status_code == 422
    assert set(response.json()["error"]["details"]) == {
        "groups[0].users[2].email"
    }


def test_fluxfast_handler_preserves_multiple_messages_at_one_path() -> None:
    errors = [
        _error(("body", "password"), "Must contain at least eight characters"),
        _error(("body", "password"), "Password is too common"),
    ]
    response = TestClient(_synthetic_validation_app(errors)).get(
        "/invalid",
        headers={HEADER_FLUXFAST: "1"},
    )

    assert response.status_code == 422
    assert response.json()["error"]["details"] == {
        "password": [
            "Must contain at least eight characters",
            "Password is too common",
        ]
    }


def test_fluxfast_handler_omits_discriminated_union_branch_label() -> None:
    response = TestClient(_validation_app()).post(
        "/discriminated-union",
        json={"pet": {"kind": "cat", "lives": 13}},
        headers={HEADER_FLUXFAST: "1"},
    )

    assert response.status_code == 422
    assert response.json()["error"]["details"] == {
        "pet.lives": ["Value error, Thirteen lives is not supported"]
    }


def test_fluxfast_handler_coalesces_ordinary_union_branch_errors() -> None:
    response = TestClient(_validation_app()).post(
        "/ordinary-union",
        json={"choice": "not-a-number-or-boolean"},
        headers={HEADER_FLUXFAST: "1"},
    )

    assert response.status_code == 422
    details = response.json()["error"]["details"]
    assert set(details) == {"choice"}
    assert len(details["choice"]) == 2


def test_fluxfast_handler_uses_stable_fallback_for_model_error() -> None:
    response = TestClient(_validation_app()).post(
        "/window",
        json={"start": 5, "end": 4},
        headers={HEADER_FLUXFAST: "1"},
    )

    assert response.status_code == 422
    details = response.json()["error"]["details"]
    assert set(details) == {"general"}
    assert "end must be greater than start" in details["general"][0]


def test_fluxfast_handler_maps_malformed_json_offset_to_general() -> None:
    response = TestClient(_validation_app()).post(
        "/window",
        content=b'{"start": 1,',
        headers={HEADER_FLUXFAST: "1", "Content-Type": "application/json"},
    )

    assert response.status_code == 422
    assert set(response.json()["error"]["details"]) == {"general"}


def test_fluxfast_handler_keeps_hostile_locations_as_plain_json_keys() -> None:
    very_long_name = f'{"x" * 10_000} unsafe'
    names = [
        "__proto__",
        "constructor",
        "prototype",
        "a.b",
        "a[b]",
        'quote"key',
        "single'quote",
        "back\\slash",
        "0",
        very_long_name,
    ]
    errors = [_error(("body", name), f"message-{index}") for index, name in enumerate(names)]
    response = TestClient(_synthetic_validation_app(errors)).get(
        "/invalid",
        headers={HEADER_FLUXFAST: "1"},
    )

    assert response.status_code == 422
    details = response.json()["error"]["details"]
    assert details["__proto__"] == ["message-0"]
    assert details["constructor"] == ["message-1"]
    assert details["prototype"] == ["message-2"]
    assert details['["a.b"]'] == ["message-3"]
    assert details['["a[b]"]'] == ["message-4"]
    assert details['["quote\\"key"]'] == ["message-5"]
    assert details["[\"single'quote\"]"] == ["message-6"]
    assert details['["back\\\\slash"]'] == ["message-7"]
    assert details['["0"]'] == ["message-8"]
    assert details[f'["{very_long_name}"]'] == ["message-9"]


def test_fluxfast_handler_does_not_leak_input_or_arbitrary_repr_in_field_key() -> None:
    secret = "submitted-secret-must-not-leak"

    class HostileSegment:
        def __str__(self) -> str:
            return secret

        def __repr__(self) -> str:
            return secret

    class HostileMessage(str):
        def __str__(self) -> str:
            raise AssertionError("unexpected __str__ call")

        def __repr__(self) -> str:
            raise AssertionError("unexpected __repr__ call")

    errors = [_error(("body", HostileSegment()), HostileMessage(secret))]
    errors[0]["input"] = secret
    response = TestClient(_synthetic_validation_app(errors, body={"token": secret})).get(
        "/invalid",
        headers={HEADER_FLUXFAST: "1"},
    )

    assert response.status_code == 422
    assert response.json()["error"]["details"] == {"general": ["Invalid value"]}
    assert secret not in response.text


@pytest.mark.parametrize(
    ("path", "payload"),
    [
        (
            "/hotels/not-an-integer/validate?page=also-not-an-integer",
            {
                "address": {},
                "addresses": [{}],
                "groups": [],
            },
        ),
        ("/window", {"start": 5, "end": 4}),
    ],
)
def test_non_fluxfast_validation_response_matches_fastapi(
    path: str,
    payload: dict[str, object],
) -> None:
    integrated_response = TestClient(_validation_app()).post(path, json=payload)
    fastapi_response = TestClient(
        _validation_app(integrate_fluxfast=False)
    ).post(path, json=payload)

    assert integrated_response.status_code == fastapi_response.status_code == 422
    assert integrated_response.headers["content-type"] == "application/json"
    assert integrated_response.json() == fastapi_response.json()
    assert "protocol" not in integrated_response.json()
