"""Build deterministic schema-codegen workloads and measure Python export."""

from __future__ import annotations

import argparse
import json
import platform
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from fastapi import FastAPI
from fluxfast import FluxFast, Page
from fluxfast import __version__ as fluxfast_version
from fluxfast.schema_export import build_app_schema_manifest
from fluxfast.schema_manifest import SchemaManifest
from fluxfast.serialization import canonical_json
from pydantic import BaseModel, Field, create_model


class BenchmarkResource(BaseModel):
    """Representative resource contract used by scaling workloads."""

    id: int
    name: str
    state: Literal["ready", "busy", "offline"]
    tags: list[str]
    metrics: dict[str, float]


class BenchmarkContract(BaseModel):
    """Compact contract that keeps the 1000-contract case within manifest bounds."""

    value: int


class NestedLeaf(BaseModel):
    """Leaf value used to construct the large nested contract."""

    id: int
    label: str
    flags: list[bool]


class BenchmarkMutationInput(BaseModel):
    """Typed JSON body repeated by the mutation-heavy workload."""

    resource_id: int = Field(ge=1)
    state: Literal["ready", "busy", "offline"]
    tags: list[str] = Field(max_length=20)


@dataclass(frozen=True, slots=True)
class Workload:
    name: str
    resources: int
    routes: int
    mutations: int
    types: int
    annotation: type[BaseModel]


def nested_contract(depth: int = 24) -> type[BaseModel]:
    """Create a stable, deeply nested Pydantic model without recursive refs."""

    annotation: type[BaseModel] = NestedLeaf
    for level in range(depth):
        annotation = create_model(
            f"NestedLevel{level:02d}",
            child=(annotation, ...),
            siblings=(list[annotation], ...),
            metrics=(dict[str, float], ...),
        )
    return annotation


def workloads() -> tuple[Workload, ...]:
    nested = nested_contract()
    return (
        Workload("contracts-10", 0, 0, 0, 10, BenchmarkContract),
        Workload("contracts-100", 0, 0, 0, 100, BenchmarkContract),
        Workload("contracts-500", 0, 0, 0, 500, BenchmarkContract),
        Workload("contracts-1000", 0, 0, 0, 1000, BenchmarkContract),
        Workload("resources-10", 10, 0, 0, 0, BenchmarkResource),
        Workload("resources-100", 100, 0, 0, 0, BenchmarkResource),
        Workload("resources-500", 500, 0, 0, 0, BenchmarkResource),
        Workload("large-nested", 10, 0, 0, 0, nested),
        Workload("many-routes", 10, 500, 0, 0, BenchmarkResource),
        Workload("many-mutations", 10, 0, 500, 0, BenchmarkResource),
    )


def _page_handler(index: int):
    async def handler(item_id: int, search: str | None = None) -> Page:
        raise AssertionError(
            f"schema export executed benchmark page {index}: {item_id} {search}"
        )

    handler.__name__ = f"benchmark_page_{index:04d}"
    return handler


def _mutation_handler(index: int):
    async def handler(payload: BenchmarkMutationInput) -> None:
        raise AssertionError(
            f"schema export executed benchmark mutation {index}: {payload}"
        )

    handler.__name__ = f"benchmark_mutation_{index:04d}"
    return handler


def build_workload_app(workload: Workload) -> FastAPI:
    app = FastAPI()
    flux = FluxFast(app)

    for index in range(workload.types):
        flux.define_type(
            f"Contract{index:04d}",
            workload.annotation,
            mode="validation",
        )

    for index in range(workload.resources):
        flux.define_resource(
            f"resource-{index:04d}",
            workload.annotation,
        )

    for index in range(workload.routes):
        flux.page(
            f"/benchmarks/pages/{index}/{{item_id}}",
            name=f"benchmark_page_{index:04d}",
        )(_page_handler(index))

    for index in range(workload.mutations):
        flux.mutation(
            f"/benchmarks/mutations/{index}",
            name=f"benchmark_mutation_{index:04d}",
        )(_mutation_handler(index))

    return app


def manifest_text(manifest: SchemaManifest) -> str:
    payload = manifest.model_dump(mode="json", by_alias=True, exclude_none=True)
    return f"{canonical_json(payload)}\n"


def producer_uses_schema_v2(producer: str) -> bool:
    """Mirror the release-era switch without adding a packaging dependency."""

    major_text, minor_text, *_ = producer.split(".", 2)
    major, minor = int(major_text), int(minor_text)
    return major > 0 or minor >= 8


def benchmark_workload(
    workload: Workload,
    *,
    samples: int,
    output_directory: Path,
) -> dict[str, object]:
    app = build_workload_app(workload)

    started = time.perf_counter()
    baseline = build_app_schema_manifest(app, producer=fluxfast_version)
    cold_export_ms = (time.perf_counter() - started) * 1_000
    baseline_payload = baseline.model_dump(
        mode="json",
        by_alias=True,
        exclude_none=True,
    )

    expected_schema = (
        "fluxfast-schema/2"
        if workload.types or producer_uses_schema_v2(fluxfast_version)
        else "fluxfast-schema/1"
    )
    assert baseline.schema_version == expected_schema
    assert len(baseline.types or {}) == workload.types
    assert len(baseline.resources) == workload.resources
    assert len(baseline.pages) == workload.routes
    assert len(baseline.mutations) == workload.mutations

    export_ms: list[float] = []
    for _ in range(samples):
        started = time.perf_counter()
        current = build_app_schema_manifest(app, producer=fluxfast_version)
        export_ms.append((time.perf_counter() - started) * 1_000)
        assert current.model_dump(
            mode="json",
            by_alias=True,
            exclude_none=True,
        ) == baseline_payload

    serialized = manifest_text(baseline)
    manifest_file = f"{workload.name}.json"
    (output_directory / manifest_file).write_text(serialized, encoding="utf8")
    return {
        "name": workload.name,
        "resources": workload.resources,
        "routes": workload.routes,
        "mutations": workload.mutations,
        "types": workload.types,
        "manifest_file": manifest_file,
        "manifest_bytes": len(serialized.encode("utf8")),
        "fingerprint": baseline.fingerprint,
        "cold_export_ms": cold_export_ms,
        "export_ms": export_ms,
    }


def run_benchmark(output_directory: Path, samples: int) -> None:
    if samples <= 0:
        raise ValueError("samples must be positive")
    output_directory.mkdir(parents=True, exist_ok=True)

    results = [
        benchmark_workload(
            workload,
            samples=samples,
            output_directory=output_directory,
        )
        for workload in workloads()
    ]
    summary = {
        "python": platform.python_version(),
        "platform": platform.platform(),
        "producer": fluxfast_version,
        "samples": samples,
        "workloads": results,
    }
    (output_directory / "summary.json").write_text(
        f"{json.dumps(summary, sort_keys=True)}\n",
        encoding="utf8",
    )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-directory", type=Path, required=True)
    parser.add_argument("--samples", type=int, default=5)
    return parser.parse_args()


if __name__ == "__main__":
    arguments = parse_args()
    run_benchmark(arguments.output_directory, arguments.samples)
