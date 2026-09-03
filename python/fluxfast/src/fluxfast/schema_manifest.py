"""Versioned offline manifest structures for FluxFast developer tooling."""

from __future__ import annotations

import math
import re
from dataclasses import dataclass
from typing import Any, Literal, TypeAlias

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    JsonValue,
    field_validator,
    model_validator,
)

from .contract import (
    _javascript_string_length,
    _validate_contract_name,
    _validate_resource_key,
)

SCHEMA_MANIFEST_V1: Literal["fluxfast-schema/1"] = "fluxfast-schema/1"
SCHEMA_MANIFEST_V2: Literal["fluxfast-schema/2"] = "fluxfast-schema/2"
# Keep the v1 name as a compatibility alias for integrations that imported it
# before schema/2 existed.  New code that needs the current format should use
# ``SCHEMA_MANIFEST_V2`` explicitly.
SCHEMA_MANIFEST_VERSION: Literal["fluxfast-schema/1"] = SCHEMA_MANIFEST_V1
SCHEMA_MANIFEST_VERSION_2: Literal["fluxfast-schema/2"] = SCHEMA_MANIFEST_V2

_FINGERPRINT_PATTERN = re.compile(r"^[0-9a-f]{64}$")
_SEMVER_PATTERN = re.compile(
    r"^(0|[1-9][0-9]*)\."
    r"(0|[1-9][0-9]*)\."
    r"(0|[1-9][0-9]*)"
    r"(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?"
    r"(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$"
)

_MAX_JSON_VALUE_COUNT = 100_000
_MAX_JSON_CHILDREN = 10_000
_MAX_JSON_DEPTH = 64
_MAX_JSON_STRING_LENGTH = 65_536
_MAX_JSON_TOTAL_STRING_LENGTH = 8 * 1024 * 1024
_MAX_JSON_SAFE_INTEGER = 9_007_199_254_740_991

JsonSchema: TypeAlias = dict[str, JsonValue]
RouteParameterLocation = Literal["path", "query"]
MutationMethod = Literal["DELETE", "PATCH", "POST", "PUT"]
ContractMode = Literal["serialization", "validation"]


@dataclass(slots=True)
class _JsonBoundsBudget:
    values: int = 0
    string_length: int = 0


def _validate_json_value_bounds(
    value: Any,
    *,
    label: str,
    budget: _JsonBoundsBudget | None = None,
) -> None:
    """Bound JSON-like data iteratively before recursive canonicalization."""

    shared_budget = budget if budget is not None else _JsonBoundsBudget()
    pending: list[tuple[Any, int, bool]] = [(value, 0, False)]
    active: set[int] = set()

    while pending:
        item, depth, exiting = pending.pop()
        if exiting:
            active.discard(id(item))
            continue

        shared_budget.values += 1
        if shared_budget.values > _MAX_JSON_VALUE_COUNT:
            raise ValueError(
                f"{label} must not contain more than "
                f"{_MAX_JSON_VALUE_COUNT} JSON values"
            )
        if depth > _MAX_JSON_DEPTH:
            raise ValueError(
                f"{label} must not exceed a nesting depth of {_MAX_JSON_DEPTH}"
            )

        if isinstance(item, str):
            item_length = _javascript_string_length(item)
            if item_length > _MAX_JSON_STRING_LENGTH:
                raise ValueError(
                    f"{label} must not contain strings longer than "
                    f"{_MAX_JSON_STRING_LENGTH} characters"
                )
            shared_budget.string_length += item_length
            if shared_budget.string_length > _MAX_JSON_TOTAL_STRING_LENGTH:
                raise ValueError(
                    f"{label} must not contain more than "
                    f"{_MAX_JSON_TOTAL_STRING_LENGTH} total string characters"
                )
            continue
        if item is None or isinstance(item, bool):
            continue
        if isinstance(item, int):
            if abs(item) > _MAX_JSON_SAFE_INTEGER:
                raise ValueError(
                    f"{label} must not contain integers outside the "
                    "JavaScript safe integer range"
                )
            continue
        if isinstance(item, float):
            if not math.isfinite(item):
                raise ValueError(f"{label} must not contain non-finite numbers")
            if item.is_integer() and abs(item) > _MAX_JSON_SAFE_INTEGER:
                raise ValueError(
                    f"{label} must not contain integers outside the "
                    "JavaScript safe integer range"
                )
            continue
        if not isinstance(item, (dict, list)):
            raise TypeError(f"{label} must contain only JSON-compatible values")

        identity = id(item)
        if identity in active:
            raise ValueError(f"{label} must not contain circular object references")
        active.add(identity)
        pending.append((item, depth, True))

        if len(item) > _MAX_JSON_CHILDREN:
            collection = "arrays" if isinstance(item, list) else "objects"
            entries = "entries" if isinstance(item, list) else "properties"
            raise ValueError(
                f"{label} must not contain {collection} with more than "
                f"{_MAX_JSON_CHILDREN} {entries}"
            )
        if isinstance(item, list):
            pending.extend((child, depth + 1, False) for child in reversed(item))
            continue

        keys = list(item)
        for key in keys:
            if not isinstance(key, str):
                raise TypeError(f"{label} object keys must be strings")
        for key in reversed(keys):
            key_length = _javascript_string_length(key)
            if key_length > _MAX_JSON_STRING_LENGTH:
                raise ValueError(
                    f"{label} must not contain keys longer than "
                    f"{_MAX_JSON_STRING_LENGTH} characters"
                )
            shared_budget.string_length += key_length
            if shared_budget.string_length > _MAX_JSON_TOTAL_STRING_LENGTH:
                raise ValueError(
                    f"{label} must not contain more than "
                    f"{_MAX_JSON_TOTAL_STRING_LENGTH} total string characters"
                )
            pending.append((item[key], depth + 1, False))


def _validate_metadata_name(value: str, *, label: str) -> str:
    if not value.strip() or _javascript_string_length(value) > 128:
        raise ValueError(f"{label} must be a non-empty string of at most 128 characters")
    if any(ord(char) < 32 or 127 <= ord(char) <= 159 for char in value):
        raise ValueError(f"{label} must not contain control characters")
    return value


def _validate_route_path(value: str) -> str:
    if not value.startswith("/") or _javascript_string_length(value) > 2048:
        raise ValueError("route path must start with '/' and be at most 2048 characters")
    if any(ord(char) < 32 or 127 <= ord(char) <= 159 for char in value):
        raise ValueError("route path must not contain control characters")
    return value


def _validate_json_schema(value: JsonSchema) -> JsonSchema:
    """Reject schemas that cannot be handled safely by JavaScript tooling."""

    _validate_json_value_bounds(value, label="JSON Schema")
    return value


class _ManifestModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ResourceSchemaEntry(_ManifestModel):
    """Serialization-mode JSON Schema for one logical resource key."""

    json_schema: JsonSchema = Field(alias="schema")

    _schema_is_standard_json = field_validator("json_schema")(_validate_json_schema)


class TypeSchemaEntry(_ManifestModel):
    """JSON Schema and Pydantic mode for one named application contract."""

    mode: ContractMode
    json_schema: JsonSchema = Field(alias="schema")

    _schema_is_standard_json = field_validator("json_schema")(_validate_json_schema)


class RouteParameterSchema(_ManifestModel):
    """Typed path or query parameter used by a generated route helper."""

    name: str
    location: RouteParameterLocation
    required: bool
    json_schema: JsonSchema = Field(alias="schema")

    _schema_is_standard_json = field_validator("json_schema")(_validate_json_schema)

    @field_validator("name")
    @classmethod
    def validate_name(cls, value: str) -> str:
        return _validate_metadata_name(value, label="route parameter name")

    @model_validator(mode="after")
    def path_parameters_are_required(self) -> RouteParameterSchema:
        if self.location == "path" and not self.required:
            raise ValueError("path parameters must be required")
        return self


class PageRouteSchema(_ManifestModel):
    """Metadata required to generate one typed page URL builder."""

    name: str
    path: str
    parameters: list[RouteParameterSchema] = Field(default_factory=list)

    @field_validator("name")
    @classmethod
    def validate_name(cls, value: str) -> str:
        return _validate_metadata_name(value, label="page route name")

    @field_validator("path")
    @classmethod
    def validate_path(cls, value: str) -> str:
        return _validate_route_path(value)


class MutationRouteSchema(_ManifestModel):
    """Metadata required to generate one typed JSON mutation helper."""

    name: str
    path: str
    method: MutationMethod
    parameters: list[RouteParameterSchema] = Field(default_factory=list)
    body_schema: JsonSchema | None = Field(default=None, alias="body")

    @field_validator("name")
    @classmethod
    def validate_name(cls, value: str) -> str:
        return _validate_metadata_name(value, label="mutation route name")

    @field_validator("path")
    @classmethod
    def validate_path(cls, value: str) -> str:
        return _validate_route_path(value)

    @field_validator("body_schema")
    @classmethod
    def validate_body_schema(cls, value: JsonSchema | None) -> JsonSchema | None:
        return _validate_json_schema(value) if value is not None else None


class SchemaManifest(_ManifestModel):
    """Complete versioned manifest consumed by FluxFast code generation."""

    schema_version: Literal["fluxfast-schema/1", "fluxfast-schema/2"] = Field(
        alias="schema"
    )
    producer: str
    fingerprint: str
    types: dict[str, TypeSchemaEntry] | None = None
    resources: dict[str, ResourceSchemaEntry] = Field(default_factory=dict)
    pages: list[PageRouteSchema] = Field(default_factory=list)
    mutations: list[MutationRouteSchema] = Field(default_factory=list)

    @field_validator("producer")
    @classmethod
    def validate_producer(cls, value: str) -> str:
        if not _SEMVER_PATTERN.fullmatch(value):
            raise ValueError("producer must use semantic version format")
        return value

    @field_validator("fingerprint")
    @classmethod
    def validate_fingerprint(cls, value: str) -> str:
        if not _FINGERPRINT_PATTERN.fullmatch(value):
            raise ValueError("fingerprint must be a lowercase SHA-256 digest")
        return value

    @field_validator("resources")
    @classmethod
    def validate_resource_keys(
        cls,
        value: dict[str, ResourceSchemaEntry],
    ) -> dict[str, ResourceSchemaEntry]:
        for key in value:
            _validate_resource_key(key)
        return value

    @field_validator("types")
    @classmethod
    def validate_type_names(
        cls,
        value: dict[str, TypeSchemaEntry] | None,
    ) -> dict[str, TypeSchemaEntry] | None:
        if value is not None:
            for name in value:
                _validate_contract_name(name)
        return value

    @model_validator(mode="after")
    def validate_schema_version_features(self) -> SchemaManifest:
        if self.schema_version == SCHEMA_MANIFEST_V1:
            if self.types is not None:
                raise ValueError(
                    "fluxfast-schema/1 cannot contain explicit type contracts"
                )
        elif self.types is None:
            raise ValueError("fluxfast-schema/2 requires a types object")
        _validate_json_value_bounds(
            self.model_dump(mode="json", by_alias=True, exclude_none=True),
            label="schema manifest",
        )
        return self
