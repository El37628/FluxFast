"""Explicit server-owned resource type contracts."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field, fields, is_dataclass
from typing import Any, Generic, TypeVar

from pydantic import BaseModel, TypeAdapter, ValidationError
from pydantic_core import PydanticSerializationError

from .errors import ResourceContractError
from .serialization import canonical_json

T = TypeVar("T")


def _contract_validation_details(
    key: str,
    error: ValidationError,
) -> dict[str, list[str]]:
    """Return useful field messages without retaining rejected input values."""

    details: dict[str, list[str]] = {}
    for item in error.errors(
        include_url=False,
        include_context=False,
        include_input=False,
    ):
        location = item.get("loc", ())
        path = ".".join((key, *(str(part) for part in location)))
        message = str(item.get("msg", "Value does not match the declared type"))
        details.setdefault(path, []).append(message)
    return details or {key: ["Value does not match the declared type"]}


def _field_wire_name(owner: type[Any], name: str) -> str:
    model_fields = getattr(owner, "__pydantic_fields__", {})
    model_field = model_fields.get(name)
    alias = getattr(model_field, "serialization_alias", None)
    return alias if isinstance(alias, str) else name


def _canonicalize_unordered_collections(source: Any, wire_value: Any) -> Any:
    """Sort serialized sets recursively while retaining sequence order."""

    if isinstance(source, BaseModel):
        if getattr(type(source), "__pydantic_root_model__", False):
            return _canonicalize_unordered_collections(source.root, wire_value)
        if not isinstance(wire_value, dict):
            return wire_value
        result = dict(wire_value)
        for name in type(source).model_fields:
            wire_name = _field_wire_name(type(source), name)
            if wire_name in result:
                result[wire_name] = _canonicalize_unordered_collections(
                    getattr(source, name),
                    result[wire_name],
                )
        return result

    if is_dataclass(source) and not isinstance(source, type):
        if not isinstance(wire_value, dict):
            return wire_value
        result = dict(wire_value)
        for dataclass_field in fields(source):
            wire_name = _field_wire_name(type(source), dataclass_field.name)
            if wire_name in result:
                result[wire_name] = _canonicalize_unordered_collections(
                    getattr(source, dataclass_field.name),
                    result[wire_name],
                )
        return result

    if isinstance(source, Mapping) and isinstance(wire_value, dict):
        result = dict(wire_value)
        for source_key, source_value in source.items():
            wire_key = source_key if source_key in result else str(source_key)
            if wire_key in result:
                result[wire_key] = _canonicalize_unordered_collections(
                    source_value,
                    result[wire_key],
                )
        return result

    if isinstance(source, (set, frozenset)) and isinstance(wire_value, list):
        if len(source) == len(wire_value):
            normalized = [
                _canonicalize_unordered_collections(item, serialized)
                for item, serialized in zip(source, wire_value, strict=True)
            ]
        else:
            normalized = list(wire_value)
        return sorted(normalized, key=canonical_json)

    if isinstance(source, (list, tuple)) and isinstance(wire_value, list):
        if len(source) != len(wire_value):
            return wire_value
        return [
            _canonicalize_unordered_collections(item, serialized)
            for item, serialized in zip(source, wire_value, strict=True)
        ]

    return wire_value


def _validate_resource_key(key: object) -> str:
    """Return a valid logical resource key or raise a public input error."""

    if not isinstance(key, str) or not key.strip() or len(key) > 128:
        raise ValueError(
            "resource key must be a non-empty string of at most 128 characters"
        )
    if "," in key or any(ord(char) < 32 for char in key):
        raise ValueError("resource key must not contain commas or control characters")
    return key


@dataclass(frozen=True, slots=True)
class ResourceContract(Generic[T]):
    """A logical resource key paired with its authoritative Python type."""

    key: str
    annotation: Any
    _adapter: TypeAdapter[T] = field(init=False, repr=False, compare=False)

    def __post_init__(self) -> None:
        object.__setattr__(self, "key", _validate_resource_key(self.key))
        object.__setattr__(self, "_adapter", TypeAdapter(self.annotation))

    def _serialize_wire(self, value: Any) -> Any:
        """Validate and serialize a loader value to its declared JSON shape."""

        message = f'Resource "{self.key}" failed its declared contract.'
        try:
            validated = self._adapter.validate_python(value)
            wire_value = self._adapter.dump_python(
                validated,
                mode="json",
                by_alias=True,
                warnings="error",
            )
        except ValidationError as error:
            raise ResourceContractError(
                message,
                details=_contract_validation_details(self.key, error),
            ) from error
        except PydanticSerializationError as error:
            raise ResourceContractError(
                message,
                details={self.key: [str(error)]},
            ) from error
        return _canonicalize_unordered_collections(validated, wire_value)

    def _serialization_schema(self) -> dict[str, Any]:
        """Return the JSON Schema describing the value emitted on the wire."""

        return self._adapter.json_schema(mode="serialization", by_alias=True)
