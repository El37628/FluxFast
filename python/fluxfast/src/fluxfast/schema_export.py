"""Offline schema-manifest construction from registered developer metadata."""

from __future__ import annotations

import hashlib
from collections.abc import Iterable, Iterator
from itertools import islice
from typing import Annotated, Any, Literal, cast

from fastapi import FastAPI
from pydantic import JsonValue, TypeAdapter
from pydantic_core import PydanticUndefined

from .route_metadata import get_fluxfast_route_metadata
from .schema_manifest import (
    _MAX_JSON_CHILDREN,
    SCHEMA_MANIFEST_V1,
    SCHEMA_MANIFEST_V2,
    MutationMethod,
    MutationRouteSchema,
    PageRouteSchema,
    ResourceSchemaEntry,
    RouteParameterSchema,
    SchemaManifest,
    TypeSchemaEntry,
    _JsonBoundsBudget,
    _validate_json_value_bounds,
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
    schema_version: str,
    types: dict[str, TypeSchemaEntry] | None,
    resources: dict[str, ResourceSchemaEntry],
    pages: list[PageRouteSchema],
    mutations: list[MutationRouteSchema],
) -> str:
    """Hash contract metadata independently from the producing package version."""

    payload = {
        "schema": schema_version,
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
    if types is not None:
        payload["types"] = {
            key: entry.model_dump(mode="json", by_alias=True)
            for key, entry in types.items()
        }
    return hashlib.sha256(canonical_json(payload).encode("utf-8")).hexdigest()


def _producer_supports_schema_v2(producer: str) -> bool:
    """Return whether a producer version belongs to the schema/2 era.

    The exporter still accepts an explicit producer version so older callers
    can reproduce schema/1 manifests. Once the Python package identifies as
    0.8 (or newer), every manifest uses schema/2, including resource-only
    applications whose ``types`` collection is empty.
    """

    parts = producer.split(".", 2)
    if len(parts) < 2 or not parts[0].isdigit() or not parts[1].isdigit():
        return False
    major, minor = int(parts[0]), int(parts[1])
    return major > 0 or (major == 0 and minor >= 8)


def build_schema_manifest(
    registry: SchemaRegistry,
    *,
    producer: str,
    pages: Iterable[PageRouteSchema] = (),
    mutations: Iterable[MutationRouteSchema] = (),
    _schema_budget: _JsonBoundsBudget | None = None,
) -> SchemaManifest:
    """Build a deterministic offline manifest without executing application logic."""

    schema_budget = _schema_budget or _JsonBoundsBudget()
    if len(registry.resource_contracts) > _MAX_JSON_CHILDREN:
        raise ValueError(
            f"schema manifest must not contain more than {_MAX_JSON_CHILDREN} resources"
        )
    if len(registry.type_contracts) > _MAX_JSON_CHILDREN:
        raise ValueError(
            f"schema manifest must not contain more than {_MAX_JSON_CHILDREN} types"
        )
    resources: dict[str, ResourceSchemaEntry] = {}
    for key, contract in sorted(registry.resource_contracts.items()):
        raw_schema: Any = contract._serialization_schema()
        _validate_json_value_bounds(
            raw_schema,
            label=f'resource schema "{key}"',
            budget=schema_budget,
        )
        resources[key] = ResourceSchemaEntry(
            schema=_sort_json_objects(raw_schema),
        )

    type_contracts: dict[str, TypeSchemaEntry] = {}
    for name, contract in sorted(registry.type_contracts.items()):
        raw_schema = contract._schema()
        _validate_json_value_bounds(
            raw_schema,
            label=f'type schema "{name}"',
            budget=schema_budget,
        )
        type_contracts[name] = TypeSchemaEntry(
            mode=contract.mode,
            schema=_sort_json_objects(raw_schema),
        )

    schema_v2 = bool(type_contracts) or _producer_supports_schema_v2(producer)
    schema_version = SCHEMA_MANIFEST_V2 if schema_v2 else SCHEMA_MANIFEST_V1
    manifest_types = type_contracts if schema_v2 else None

    page_values = list(islice(pages, _MAX_JSON_CHILDREN + 1))
    if len(page_values) > _MAX_JSON_CHILDREN:
        raise ValueError(
            f"schema manifest must not contain more than {_MAX_JSON_CHILDREN} pages"
        )
    mutation_values = list(islice(mutations, _MAX_JSON_CHILDREN + 1))
    if len(mutation_values) > _MAX_JSON_CHILDREN:
        raise ValueError(
            f"schema manifest must not contain more than {_MAX_JSON_CHILDREN} mutations"
        )
    sorted_pages = sorted(page_values, key=lambda page: (page.name, page.path))
    sorted_mutations = sorted(
        mutation_values,
        key=lambda mutation: (mutation.name, mutation.path, mutation.method),
    )

    return SchemaManifest(
        schema=schema_version,
        producer=producer,
        types=manifest_types,
        fingerprint=_manifest_fingerprint(
            schema_version,
            manifest_types,
            resources,
            sorted_pages,
            sorted_mutations,
        ),
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


def _parameter_schema(
    location: Literal["path", "query"],
    field: Any,
    schema_budget: _JsonBoundsBudget,
) -> RouteParameterSchema:
    field_info = field.field_info
    annotation = field_info.annotation
    annotated = Annotated[annotation, field_info]
    raw_schema: Any = TypeAdapter(annotated).json_schema(
        mode="serialization",
        by_alias=True,
    )
    _validate_json_value_bounds(
        raw_schema,
        label=f'page parameter schema "{field.alias or field.name}"',
        budget=schema_budget,
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


def _mutation_parameter_schema(
    location: Literal["path", "query"],
    field: Any,
    schema_budget: _JsonBoundsBudget,
) -> RouteParameterSchema:
    """Build input-mode metadata for a mutation path or query parameter."""

    field_info = field.field_info
    annotation = field_info.annotation
    annotated = Annotated[annotation, field_info]
    raw_schema: Any = TypeAdapter(annotated).json_schema(
        mode="validation",
        by_alias=True,
    )
    _validate_json_value_bounds(
        raw_schema,
        label=f'mutation parameter schema "{field.alias or field.name}"',
        budget=schema_budget,
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


def _export_page_routes(
    app: FastAPI,
    schema_budget: _JsonBoundsBudget,
) -> list[PageRouteSchema]:
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
            parameters.append(_parameter_schema(location, field, schema_budget))
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


_SUPPORTED_MUTATION_METHODS = frozenset({"DELETE", "PATCH", "POST", "PUT"})


def _json_body_schema(
    route: Any,
    schema_budget: _JsonBoundsBudget,
) -> dict[str, JsonValue] | None:
    """Return the accepted JSON body schema, omitting non-JSON request bodies."""

    body_field = getattr(route, "body_field", None)
    if body_field is None:
        return None
    field_info = body_field.field_info
    media_type = getattr(field_info, "media_type", "application/json")
    if not isinstance(media_type, str):
        return None
    base_media_type = media_type.partition(";")[0].strip().lower()
    if not (
        base_media_type == "application/json" or base_media_type.endswith("+json")
    ):
        return None

    annotation = field_info.annotation
    annotated = Annotated[annotation, field_info]
    raw_schema: Any = TypeAdapter(annotated).json_schema(
        mode="validation",
        by_alias=True,
    )
    _validate_json_value_bounds(
        raw_schema,
        label="mutation body schema",
        budget=schema_budget,
    )
    return cast(dict[str, JsonValue], _sort_json_objects(raw_schema))


def _export_mutation_routes(
    app: FastAPI,
    schema_budget: _JsonBoundsBudget,
) -> list[MutationRouteSchema]:
    mutations: list[MutationRouteSchema] = []
    for route in _iter_effective_routes(app):
        metadata = get_fluxfast_route_metadata(getattr(route, "endpoint", None))
        if metadata is None or metadata.kind != "mutation":
            continue

        parameters: list[RouteParameterSchema] = []
        seen_parameters: set[tuple[str, str]] = set()
        for location, field in _iter_parameter_fields(route.dependant):
            name = field.alias or field.name
            identity = (location, name)
            if identity in seen_parameters:
                continue
            seen_parameters.add(identity)
            parameters.append(
                _mutation_parameter_schema(location, field, schema_budget)
            )
        parameters.sort(
            key=lambda parameter: (
                0 if parameter.location == "path" else 1,
                parameter.name,
            )
        )

        body_schema = _json_body_schema(route, schema_budget)
        methods = sorted(
            method
            for method in metadata.methods
            if method in _SUPPORTED_MUTATION_METHODS
        )
        for method in methods:
            mutations.append(
                MutationRouteSchema(
                    name=metadata.name,
                    path=route.path,
                    method=cast(MutationMethod, method),
                    parameters=parameters,
                    body=body_schema,
                )
            )
    return mutations


def build_app_schema_manifest(
    app: FastAPI,
    *,
    producer: str,
) -> SchemaManifest:
    """Build an offline manifest from one integrated FastAPI application."""

    registry = getattr(app.state, "fluxfast_schema_registry", None)
    if not isinstance(registry, SchemaRegistry):
        raise TypeError("FastAPI application is not configured with FluxFast")
    schema_budget = _JsonBoundsBudget()
    return build_schema_manifest(
        registry,
        producer=producer,
        pages=_export_page_routes(app, schema_budget),
        mutations=_export_mutation_routes(app, schema_budget),
        _schema_budget=schema_budget,
    )
