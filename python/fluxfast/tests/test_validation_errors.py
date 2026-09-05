"""Regression coverage for authoritative FastAPI validation errors."""

from __future__ import annotations

from collections import deque
from collections.abc import Mapping, Sequence
from enum import Enum
from typing import Annotated, Literal, Self

import pytest
from fastapi import Body, Cookie, Depends, FastAPI, Header, Query
from fastapi.exceptions import RequestValidationError
from fastapi.testclient import TestClient
from pydantic import (
    AliasChoices,
    BaseModel,
    ConfigDict,
    Field,
    RootModel,
    field_validator,
    model_validator,
)

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


class AliasChild(BaseModel):
    model_config = ConfigDict(loc_by_alias=False)

    count: int = Field(alias="wireCount")


class AliasPayload(BaseModel):
    model_config = ConfigDict(loc_by_alias=False)

    child: AliasChild = Field(alias="wireChild")


class Leaf(BaseModel):
    value: int


class OptionalNestedPayload(BaseModel):
    leaf: Leaf | None
    leaves: list[Leaf] | None
    mapping: dict[str, Leaf] | None


class BranchA(BaseModel):
    model_config = ConfigDict(loc_by_alias=False)

    kind: Literal["a"]
    value: int = Field(alias="aValue")


class BranchB(BaseModel):
    model_config = ConfigDict(loc_by_alias=False)

    kind: Literal["b"]
    value: int = Field(alias="bValue")


class AliasedUnionPayload(BaseModel):
    branch: Annotated[BranchA | BranchB, Field(discriminator="kind")]


class RootCollection(RootModel[list[Leaf | int]]):
    pass


class GroupedQuery(BaseModel):
    choice: int | bool


class AbstractCollectionsPayload(BaseModel):
    sequence: Sequence[Leaf | int]
    mapping: Mapping[str, Leaf | int]
    queue: deque[Leaf | int]


class Kind(str, Enum):
    a = "a"
    b = "b"


class EnumBranchA(BaseModel):
    model_config = ConfigDict(loc_by_alias=False)

    kind: Literal[Kind.a]
    value: int = Field(alias="aValue")


class EnumBranchB(BaseModel):
    model_config = ConfigDict(loc_by_alias=False)

    kind: Literal[Kind.b]
    value: int = Field(alias="bValue")


class EnumUnionPayload(BaseModel):
    branch: Annotated[EnumBranchA | EnumBranchB, Field(discriminator="kind")]


class TrueBranch(BaseModel):
    model_config = ConfigDict(loc_by_alias=False)

    kind: Literal[True]
    value: int = Field(alias="trueValue")


class FalseBranch(BaseModel):
    model_config = ConfigDict(loc_by_alias=False)

    kind: Literal[False]
    value: int = Field(alias="falseValue")


class BooleanUnionPayload(BaseModel):
    branch: Annotated[TrueBranch | FalseBranch, Field(discriminator="kind")]


class AliasChoicesChild(BaseModel):
    model_config = ConfigDict(loc_by_alias=False)

    value: int = Field(validation_alias=AliasChoices("newValue", "legacyValue"))


class AliasChoicesPayload(BaseModel):
    child: AliasChoicesChild


class MappingKeyPayload(BaseModel):
    values: dict[int, str]


def _validation_dependency(
    query_choice: Annotated[int | bool, Query(alias="q-choice")],
    header_choice: Annotated[int | bool, Header(alias="h-choice")],
    cookie_choice: Annotated[int | bool, Cookie(alias="c-choice")],
) -> None:
    pass


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

    @app.post("/root-union")
    async def validate_root_union(payload: Annotated[int | bool, Body()]) -> None:
        pass

    @app.get("/query-union")
    async def validate_query_union(choice: int | bool) -> None:
        pass

    @app.get("/header-union")
    async def validate_header_union(
        choice: Annotated[int | bool, Header(alias="x-choice")],
    ) -> None:
        pass

    @app.get("/cookie-union")
    async def validate_cookie_union(
        choice: Annotated[int | bool, Cookie()],
    ) -> None:
        pass

    @app.post("/aliases")
    async def validate_aliases(payload: AliasPayload) -> None:
        pass

    @app.post("/optional-nested")
    async def validate_optional_nested(payload: OptionalNestedPayload) -> None:
        pass

    @app.post("/aliased-union")
    async def validate_aliased_union(payload: AliasedUnionPayload) -> None:
        pass

    @app.post("/root-model")
    async def validate_root_model(payload: RootCollection) -> None:
        pass

    @app.get("/dependency-unions")
    async def validate_dependency_unions(
        dependency: Annotated[None, Depends(_validation_dependency)],
    ) -> None:
        pass

    @app.get("/grouped-query")
    async def validate_grouped_query(filters: Annotated[GroupedQuery, Query()]) -> None:
        pass

    @app.post("/abstract-collections")
    async def validate_abstract_collections(payload: AbstractCollectionsPayload) -> None:
        pass

    @app.post("/enum-union")
    async def validate_enum_union(payload: EnumUnionPayload) -> None:
        pass

    @app.post("/boolean-union")
    async def validate_boolean_union(payload: BooleanUnionPayload) -> None:
        pass

    @app.post("/alias-choices")
    async def validate_alias_choices(payload: AliasChoicesPayload) -> None:
        pass

    @app.post("/mapping-keys")
    async def validate_mapping_keys(payload: MappingKeyPayload) -> None:
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


def test_invalid_discriminator_message_does_not_reflect_submitted_value() -> None:
    secret = "submitted-secret-discriminator-must-not-leak"
    response = TestClient(_validation_app()).post(
        "/discriminated-union",
        json={"pet": {"kind": secret, "lives": 9}},
        headers={HEADER_FLUXFAST: "1"},
    )

    assert response.status_code == 422
    assert response.json()["error"]["details"] == {
        "pet": ["Invalid discriminator value"]
    }
    assert secret not in response.text


def test_union_branch_label_cannot_collide_with_submitted_property() -> None:
    response = TestClient(_validation_app()).post(
        "/discriminated-union",
        json={
            "pet": {
                "kind": "cat",
                "lives": 13,
                "cat": {"lives": 9},
            }
        },
        headers={HEADER_FLUXFAST: "1"},
    )

    assert response.status_code == 422
    assert set(response.json()["error"]["details"]) == {"pet.lives"}


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


def test_fluxfast_handler_omits_root_union_branch_labels() -> None:
    response = TestClient(_validation_app()).post(
        "/root-union",
        json="not-a-number-or-boolean",
        headers={HEADER_FLUXFAST: "1"},
    )

    assert response.status_code == 422
    details = response.json()["error"]["details"]
    assert set(details) == {"general"}
    assert len(details["general"]) == 2


def test_fluxfast_handler_omits_non_body_union_branch_labels() -> None:
    client = TestClient(_validation_app())
    client.cookies.set("choice", "nope")
    responses = [
        (client.get("/query-union?choice=nope", headers={HEADER_FLUXFAST: "1"}), "choice"),
        (
            client.get(
                "/header-union",
                headers={HEADER_FLUXFAST: "1", "x-choice": "nope"},
            ),
            '["x-choice"]',
        ),
        (
            client.get(
                "/cookie-union",
                headers={HEADER_FLUXFAST: "1"},
            ),
            "choice",
        ),
    ]

    for response, expected_key in responses:
        assert response.status_code == 422
        details = response.json()["error"]["details"]
        assert set(details) == {expected_key}
        assert len(details[expected_key]) == 2


def test_validation_locations_resolve_wire_aliases_from_model_metadata() -> None:
    response = TestClient(_validation_app()).post(
        "/aliases",
        json={"wireChild": {"wireCount": "not-an-integer"}},
        headers={HEADER_FLUXFAST: "1"},
    )

    assert response.status_code == 422
    assert set(response.json()["error"]["details"]) == {"wireChild.wireCount"}


def test_nullable_containers_preserve_real_nested_segments() -> None:
    response = TestClient(_validation_app()).post(
        "/optional-nested",
        json={
            "leaf": {"value": "invalid"},
            "leaves": [{"value": "invalid"}],
            "mapping": {"entry": {"value": "invalid"}},
        },
        headers={HEADER_FLUXFAST: "1"},
    )

    assert response.status_code == 422
    assert set(response.json()["error"]["details"]) == {
        "leaf.value",
        "leaves[0].value",
        "mapping.entry.value",
    }


def test_union_label_selects_the_branch_with_matching_aliases() -> None:
    response = TestClient(_validation_app()).post(
        "/aliased-union",
        json={"branch": {"kind": "b", "bValue": "invalid"}},
        headers={HEADER_FLUXFAST: "1"},
    )

    assert response.status_code == 422
    assert set(response.json()["error"]["details"]) == {"branch.bValue"}


def test_root_model_paths_omit_root_and_union_labels() -> None:
    response = TestClient(_validation_app()).post(
        "/root-model",
        json=[{"value": "invalid"}],
        headers={HEADER_FLUXFAST: "1"},
    )

    assert response.status_code == 422
    assert set(response.json()["error"]["details"]) == {"[0]", "[0].value"}


def test_dependency_owned_union_locations_use_declared_parameters() -> None:
    client = TestClient(_validation_app())
    client.cookies.set("c-choice", "invalid")
    response = client.get(
        "/dependency-unions?q-choice=invalid",
        headers={HEADER_FLUXFAST: "1", "h-choice": "invalid"},
    )

    assert response.status_code == 422
    details = response.json()["error"]["details"]
    assert set(details) == {'["q-choice"]', '["h-choice"]', '["c-choice"]'}
    assert all(len(messages) == 2 for messages in details.values())


def test_grouped_model_union_location_omits_wrapper_and_branch() -> None:
    response = TestClient(_validation_app()).get(
        "/grouped-query?choice=invalid",
        headers={HEADER_FLUXFAST: "1"},
    )

    assert response.status_code == 422
    details = response.json()["error"]["details"]
    assert set(details) == {"choice"}
    assert len(details["choice"]) == 2


def test_abstract_collection_union_labels_are_omitted() -> None:
    response = TestClient(_validation_app()).post(
        "/abstract-collections",
        json={
            "sequence": [{"value": "invalid"}],
            "mapping": {"entry": {"value": "invalid"}},
            "queue": [{"value": "invalid"}],
        },
        headers={HEADER_FLUXFAST: "1"},
    )

    assert response.status_code == 422
    assert set(response.json()["error"]["details"]) == {
        "sequence[0].value",
        "sequence[0]",
        "mapping.entry.value",
        "mapping.entry",
        "queue[0].value",
        "queue[0]",
    }


@pytest.mark.parametrize(
    ("path", "payload", "expected"),
    [
        (
            "/enum-union",
            {"branch": {"kind": "b", "bValue": "invalid"}},
            "branch.bValue",
        ),
        (
            "/boolean-union",
            {"branch": {"kind": False, "falseValue": "invalid"}},
            "branch.falseValue",
        ),
    ],
)
def test_enum_and_boolean_union_labels_select_the_declared_branch(
    path: str,
    payload: dict[str, object],
    expected: str,
) -> None:
    response = TestClient(_validation_app()).post(
        path,
        json=payload,
        headers={HEADER_FLUXFAST: "1"},
    )

    assert response.status_code == 422
    assert set(response.json()["error"]["details"]) == {expected}


def test_alias_choices_use_the_primary_validation_schema_name() -> None:
    response = TestClient(_validation_app()).post(
        "/alias-choices",
        json={"child": {"legacyValue": "invalid"}},
        headers={HEADER_FLUXFAST: "1"},
    )

    assert response.status_code == 422
    assert set(response.json()["error"]["details"]) == {"child.newValue"}


def test_mapping_key_marker_is_not_exposed_as_a_field_segment() -> None:
    response = TestClient(_validation_app()).post(
        "/mapping-keys",
        json={"values": {"bad": "value"}},
        headers={HEADER_FLUXFAST: "1"},
    )

    assert response.status_code == 422
    assert set(response.json()["error"]["details"]) == {"values.bad"}


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
