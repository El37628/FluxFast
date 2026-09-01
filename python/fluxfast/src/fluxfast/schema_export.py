"""Offline schema-manifest construction from registered developer metadata."""

from __future__ import annotations

import hashlib
from typing import Any

from pydantic import JsonValue

from .schema_manifest import (
    SCHEMA_MANIFEST_VERSION,
    ResourceSchemaEntry,
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
) -> str:
    """Hash contract metadata independently from the producing package version."""

    payload = {
        "schema": SCHEMA_MANIFEST_VERSION,
        "resources": {
            key: entry.model_dump(mode="json", by_alias=True)
            for key, entry in resources.items()
        },
        "pages": [],
        "mutations": [],
    }
    return hashlib.sha256(canonical_json(payload).encode("utf-8")).hexdigest()


def build_schema_manifest(
    registry: SchemaRegistry,
    *,
    producer: str,
) -> SchemaManifest:
    """Build a deterministic offline manifest without executing application logic."""

    resources: dict[str, ResourceSchemaEntry] = {}
    for key, contract in sorted(registry.resource_contracts.items()):
        raw_schema: Any = contract._serialization_schema()
        resources[key] = ResourceSchemaEntry(
            schema=_sort_json_objects(raw_schema),
        )

    return SchemaManifest(
        schema=SCHEMA_MANIFEST_VERSION,
        producer=producer,
        fingerprint=_manifest_fingerprint(resources),
        resources=resources,
    )
