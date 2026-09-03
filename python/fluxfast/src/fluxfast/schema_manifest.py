"""Versioned offline manifest structures for FluxFast developer tooling."""

from __future__ import annotations

import math
import re
from typing import Literal, TypeAlias

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    JsonValue,
    field_validator,
    model_validator,
)

from .contract import _validate_contract_name, _validate_resource_key

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

JsonSchema: TypeAlias = dict[str, JsonValue]
RouteParameterLocation = Literal["path", "query"]
MutationMethod = Literal["DELETE", "PATCH", "POST", "PUT"]
ContractMode = Literal["serialization", "validation"]


def _validate_metadata_name(value: str, *, label: str) -> str:
    if not value.strip() or len(value) > 128:
        raise ValueError(f"{label} must be a non-empty string of at most 128 characters")
    if any(ord(char) < 32 for char in value):
        raise ValueError(f"{label} must not contain control characters")
    return value


def _validate_route_path(value: str) -> str:
    if not value.startswith("/") or len(value) > 2048:
        raise ValueError("route path must start with '/' and be at most 2048 characters")
    if any(ord(char) < 32 for char in value):
        raise ValueError("route path must not contain control characters")
    return value


def _validate_json_schema(value: JsonSchema) -> JsonSchema:
    """Reject non-finite numbers that standard JSON cannot represent."""

    pending: list[JsonValue] = [value]
    while pending:
        item = pending.pop()
        if isinstance(item, float) and not math.isfinite(item):
            raise ValueError("JSON Schema must not contain non-finite numbers")
        if isinstance(item, dict):
            pending.extend(item.values())
        elif isinstance(item, list):
            pending.extend(item)
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
        return self
