"""Page descriptor representing a FluxFast page response."""

from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any

from .resource import ResourceSpec


@dataclass(slots=True)
class Page:
    """Represents a server-rendered FluxFast page definition."""

    component: str
    resources: list[ResourceSpec] = field(default_factory=list)
    meta: Mapping[str, Any] | None = field(default_factory=dict)

    def __post_init__(self) -> None:
        if not isinstance(self.component, str) or not self.component.strip():
            raise ValueError("page component must be a non-empty string")
        self.meta = dict(self.meta or {})

        keys = [spec.key for spec in self.resources]
        duplicates = sorted({key for key in keys if keys.count(key) > 1})
        if duplicates:
            raise ValueError(
                "page resource keys must be unique; duplicates: "
                + ", ".join(duplicates)
            )
