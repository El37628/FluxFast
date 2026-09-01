"""Explicit metadata markers for routes owned by FluxFast."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

FLUXFAST_ROUTE_METADATA_ATTRIBUTE = "__fluxfast_route_metadata__"


@dataclass(frozen=True, slots=True)
class FluxRouteMetadata:
    """Developer metadata attached to a registered FluxFast endpoint."""

    kind: Literal["mutation", "page"]
    name: str
    path: str
    methods: tuple[str, ...]


def mark_fluxfast_route(endpoint: object, metadata: FluxRouteMetadata) -> None:
    """Attach explicit metadata without changing the endpoint signature."""

    setattr(endpoint, FLUXFAST_ROUTE_METADATA_ATTRIBUTE, metadata)


def get_fluxfast_route_metadata(endpoint: object) -> FluxRouteMetadata | None:
    """Return explicit FluxFast metadata attached during registration."""

    metadata = getattr(endpoint, FLUXFAST_ROUTE_METADATA_ATTRIBUTE, None)
    return metadata if isinstance(metadata, FluxRouteMetadata) else None
