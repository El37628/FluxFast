"""Explicit server-owned resource type contracts."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Generic, TypeVar

from pydantic import TypeAdapter

T = TypeVar("T")


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
