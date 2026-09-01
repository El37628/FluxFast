"""Offline schema-manifest construction from registered developer metadata."""

from __future__ import annotations

import hashlib
from collections.abc import Iterable, Iterator
from typing import Annotated, Any, Literal

from fastapi import FastAPI
from pydantic import JsonValue, TypeAdapter
from pydantic_core import PydanticUndefined

from .route_metadata import get_fluxfast_route_metadata
from .schema_manifest import (
    SCHEMA_MANIFEST_VERSION,
    MutationRouteSchema,
    PageRouteSchema,
    ResourceSchemaEntry,
    RouteParameterSchema,
    SchemaManifest,
)
from .schema_registry import SchemaRegistry
from .serialization import canonical_json


def _sort_json_objects(value: JsonValue) -> JsonValue:
    """Sort object keys recursively without changing semantically ordered arrays."""

    if isinstance(value, dict):
        return {key: _sort_json_objects(value[key]) for key in sorted(value)}
    if isinstance(value, list):
        return [_sort_json_objects(item) for item in value]
    return value


def _manifest_fingerprint(
    resources: dict[str, ResourceSchemaEntry],
    pages: list[PageRouteSchema],
    mutations: list[MutationRouteSchema],
) -> str:
    """Hash contract metadata independently from the producing package version."""

    payload = {
        "schema": SCHEMA_MANIFEST_VERSION,
        "resources": {
            key: entry.model_dump(mode="json", by_alias=True)
            for key, entry in resources.items()
        },
        "pages": [page.model_dump(mode="json", by_alias=True) for page in pages],
        "mutations": [
            mutation.model_dump(mode="json", by_alias=True, exclude_none=True)
            for mutation in mutations
        ],
    }
    return hashlib.sha256(canonical_json(payload).encode("utf-8")).hexdigest()


def build_schema_manifest(
    registry: SchemaRegistry,
    *,
    producer: str,
    pages: Iterable[PageRouteSchema] = (),
    mutations: Iterable[MutationRouteSchema] = (),
) -> SchemaManifest:
    """Build a deterministic offline manifest without executing application logic."""

    resources: dict[str, ResourceSchemaEntry] = {}
    for key, contract in sorted(registry.resource_contracts.items()):
        raw_schema: Any = contract._serialization_schema()
        resources[key] = ResourceSchemaEntry(
            schema=_sort_json_objects(raw_schema),
        )

    sorted_pages = sorted(pages, key=lambda page: (page.name, page.path))
    sorted_mutations = sorted(
        mutations,
        key=lambda mutation: (mutation.name, mutation.path, mutation.method),
    )

    return SchemaManifest(
        schema=SCHEMA_MANIFEST_VERSION,
        producer=producer,
        fingerprint=_manifest_fingerprint(resources, sorted_pages, sorted_mutations),
        resources=resources,
        pages=sorted_pages,
        mutations=sorted_mutations,
    )


def _iter_effective_routes(app: FastAPI) -> Iterator[Any]:
    """Yield direct and included routes with their effective prefixed metadata."""

    for route in app.routes:
        effective_contexts = getattr(route, "effective_route_contexts", None)
        if callable(effective_contexts):
            yield from effective_contexts()
        else:
            yield route


def _iter_parameter_fields(
    dependant: Any,
    visited: set[int] | None = None,
) -> Iterator[tuple[Literal["path", "query"], Any]]:
    """Yield page and dependency parameters without resolving dependencies."""

    if visited is None:
        visited = set()
    identity = id(dependant)
    if identity in visited:
        return
    visited.add(identity)

    for field in getattr(dependant, "path_params", ()):
        yield "path", field
    for field in getattr(dependant, "query_params", ()):
        yield "query", field
    for dependency in getattr(dependant, "dependencies", ()):
        yield from _iter_parameter_fields(dependency, visited)


def _parameter_schema(location: Literal["path", "query"], field: Any) -> RouteParameterSchema:
    field_info = field.field_info
    annotation = field_info.annotation
    annotated = Annotated[annotation, field_info]
    raw_schema: Any = TypeAdapter(annotated).json_schema(
        mode="serialization",
        by_alias=True,
    )
    is_required = getattr(field_info, "is_required", None)
    required = (
        bool(is_required())
        if callable(is_required)
        else field.default is PydanticUndefined
    )
    return RouteParameterSchema(
        name=field.alias or field.name,
        location=location,
        required=required,
        schema=_sort_json_objects(raw_schema),
    )


def _export_page_routes(app: FastAPI) -> list[PageRouteSchema]:
    pages: list[PageRouteSchema] = []
    for route in _iter_effective_routes(app):
        metadata = get_fluxfast_route_metadata(getattr(route, "endpoint", None))
        if metadata is None or metadata.kind != "page":
            continue

        parameters: list[RouteParameterSchema] = []
        seen_parameters: set[tuple[str, str]] = set()
        for location, field in _iter_parameter_fields(route.dependant):
            name = field.alias or field.name
            identity = (location, name)
            if identity in seen_parameters:
                continue
            seen_parameters.add(identity)
            parameters.append(_parameter_schema(location, field))
        parameters.sort(
            key=lambda parameter: (
                0 if parameter.location == "path" else 1,
                parameter.name,
            )
        )
        pages.append(
            PageRouteSchema(
                name=metadata.name,
                path=route.path,
                parameters=parameters,
            )
        )
    return pages


def build_app_schema_manifest(
    app: FastAPI,
    *,
    producer: str,
) -> SchemaManifest:
    """Build an offline manifest from one integrated FastAPI application."""

    registry = getattr(app.state, "fluxfast_schema_registry", None)
    if not isinstance(registry, SchemaRegistry):
        raise TypeError("FastAPI application is not configured with FluxFast")
    return build_schema_manifest(
        registry,
        producer=producer,
        pages=_export_page_routes(app),
    )
