"""Compatibility locks for the v0.7 developer-contract surface before v0.8."""

from __future__ import annotations

from fastapi import FastAPI
from pydantic import BaseModel

from fluxfast import FluxFast
from fluxfast.schema_export import build_schema_manifest
from fluxfast.schema_manifest import SCHEMA_MANIFEST_V2, SCHEMA_MANIFEST_VERSION


class BaselineRoom(BaseModel):
    id: int


def test_resource_only_manifests_keep_schema1_shape() -> None:
    flux = FluxFast(FastAPI())
    flux.define_resource("rooms", list[BaselineRoom])

    manifest = build_schema_manifest(flux.schema_registry, producer="0.7.0")

    assert manifest.schema_version == SCHEMA_MANIFEST_VERSION
    assert list(manifest.resources) == ["rooms"]
    serialized = manifest.model_dump(mode="json", by_alias=True, exclude_none=True)
    assert "types" not in serialized
    assert set(serialized) == {
        "schema",
        "producer",
        "fingerprint",
        "resources",
        "pages",
        "mutations",
    }


def test_v08_resource_only_manifests_emit_schema2_with_empty_types() -> None:
    flux = FluxFast(FastAPI())
    flux.define_resource("rooms", list[BaselineRoom])

    manifest = build_schema_manifest(flux.schema_registry, producer="0.8.0")

    assert manifest.schema_version == SCHEMA_MANIFEST_V2
    assert manifest.types == {}
    serialized = manifest.model_dump(mode="json", by_alias=True, exclude_none=True)
    assert serialized["types"] == {}
