"""Parallel resource resolution engine using AnyIO structured concurrency."""

import inspect
import time
from dataclasses import dataclass
from typing import Any

import anyio

from .cache import CachedResource, ResourceCacheBackend
from .devtools import (
    RequestDiagnosticCollector,
    ResourceDiagnostic,
    classify_cache_backend,
)
from .errors import ResourceContractError, ResourceError
from .page import Page
from .protocol import ResourceErrorDetail, ResourceWireRecord
from .resource import ResourceSpec
from .serialization import compute_version, to_jsonable
from .timing import TimingMetrics


@dataclass(slots=True)
class ResourceResolution:
    """Internal result of resolving immediate and pending page resources."""

    resources: dict[str, ResourceWireRecord[Any]]
    deferred: list[str]
    errors: dict[str, ResourceErrorDetail]


class ResourceEngine:
    """Resolves page resource graphs concurrently with cache scoping and delta omission."""

    @staticmethod
    def get_cache_key(spec: ResourceSpec) -> str:
        return f"{spec.scope.fingerprint()}::{spec.key}"

    @classmethod
    async def resolve_page_resources(
        cls,
        page: Page,
        known_versions: dict[str, str],
        only_keys: set[str] | None,
        cache: ResourceCacheBackend,
        metrics: TimingMetrics,
        *,
        client_supports_deferred: bool = False,
        debug: bool = False,
        diagnostics: RequestDiagnosticCollector | None = None,
    ) -> ResourceResolution:
        t0 = time.perf_counter()

        specs_to_process = page.resources
        if only_keys is not None:
            specs_to_process = [s for s in specs_to_process if s.key in only_keys]

        resolved_records: dict[str, ResourceWireRecord[Any]] = {}
        deferred_keys: list[str] = []
        resource_errors: dict[str, ResourceErrorDetail] = {}
        pending_misses: list[ResourceSpec] = []
        resource_diagnostics: dict[str, ResourceDiagnostic] | None = (
            {} if diagnostics is not None else None
        )
        cache_backend = (
            classify_cache_backend(cache) if diagnostics is not None else None
        )

        # 1. Evaluate cache hits
        for spec in specs_to_process:
            diagnostic = None
            if diagnostics is not None:
                assert cache_backend is not None
                diagnostic = diagnostics.start_resource(
                    key=spec.key,
                    scope_type=spec.scope.scope_type.value,
                    ttl=spec.ttl,
                    deferred=spec.defer,
                    live=spec.live,
                    cache_backend=cache_backend,
                )
                if diagnostic is not None:
                    assert resource_diagnostics is not None
                    resource_diagnostics[spec.key] = diagnostic
            if spec.scope.is_cacheable and spec.ttl > 0:
                cache_key = cls.get_cache_key(spec)
                cache_started_at = (
                    time.perf_counter() if diagnostics is not None else None
                )
                try:
                    cached = await cache.get(cache_key)
                except Exception:
                    if diagnostics is not None:
                        assert cache_started_at is not None
                        diagnostics.record_cache(
                            diagnostic,
                            hit=False,
                            duration_ms=(
                                time.perf_counter() - cache_started_at
                            )
                            * 1000.0,
                        )
                        diagnostics.finish_resource(
                            diagnostic,
                            result="error",
                            error_type="ResourceCacheError",
                        )
                    raise
                if diagnostics is not None:
                    assert cache_started_at is not None
                    diagnostics.record_cache(
                        diagnostic,
                        hit=cached is not None,
                        duration_ms=(time.perf_counter() - cache_started_at)
                        * 1000.0,
                    )
                if cached is not None:
                    metrics.cache_hits += 1
                    if spec.defer:
                        metrics.deferred_cache_hits += 1
                    # Compare with client-known version
                    client_ver = known_versions.get(spec.key)
                    if client_ver == cached.version:
                        # Client already has identical version -> omit
                        metrics.resources_omitted += 1
                        if diagnostics is not None:
                            diagnostics.finish_resource(
                                diagnostic,
                                result="omitted-known",
                                known_version=True,
                            )
                    else:
                        # Client has different or no version -> send cached record
                        metrics.resources_sent += 1
                        resolved_records[spec.key] = ResourceWireRecord(
                            version=cached.version,
                            value=cached.value,
                        )
                        if diagnostics is not None:
                            diagnostics.finish_resource(
                                diagnostic,
                                result="cache-hit",
                                sent=True,
                            )
                    continue

            # Cache miss or uncacheable
            metrics.cache_misses += 1
            if spec.defer and client_supports_deferred and only_keys is None:
                deferred_keys.append(spec.key)
                metrics.resources_deferred += 1
                if diagnostics is not None:
                    diagnostics.finish_resource(
                        diagnostic,
                        result="deferred",
                    )
                continue
            pending_misses.append(spec)

        # 2. Concurrently resolve misses
        if pending_misses:
            miss_results: dict[str, tuple[str, Any, ResourceSpec]] = {}

            async def _resolve_single(spec: ResourceSpec) -> None:
                diagnostic = (
                    resource_diagnostics.get(spec.key)
                    if resource_diagnostics is not None
                    else None
                )
                loader_started_at = (
                    time.perf_counter() if diagnostics is not None else None
                )
                try:
                    loader = spec.loader
                    if inspect.iscoroutinefunction(loader):
                        val = await loader()
                    else:
                        # A synchronous loader may perform blocking database or
                        # filesystem work. Run it in AnyIO's worker pool so one
                        # loader cannot serialize every other resource miss.
                        val = await anyio.to_thread.run_sync(loader)
                        if inspect.isawaitable(val):
                            val = await val

                    wire_value = (
                        spec.contract._serialize_wire(val)
                        if spec.contract is not None
                        else to_jsonable(val)
                    )
                    ver = compute_version(wire_value)
                    if spec.defer and only_keys is not None:
                        metrics.deferred_resolved += 1
                    miss_results[spec.key] = (ver, wire_value, spec)
                except ResourceContractError as error:
                    if (
                        spec.defer
                        and client_supports_deferred
                        and only_keys is not None
                    ):
                        metrics.deferred_errors += 1
                        resource_errors[spec.key] = ResourceErrorDetail(
                            type="ResourceContractError",
                            message=(
                                error.message
                                if debug
                                else "A deferred resource could not be resolved"
                            ),
                            details=error.details if debug else None,
                        )
                        if diagnostics is not None:
                            diagnostics.finish_resource(
                                diagnostic,
                                result="error",
                                error_type="ResourceContractError",
                            )
                        return
                    if diagnostics is not None:
                        diagnostics.finish_resource(
                            diagnostic,
                            result="error",
                            error_type="ResourceContractError",
                        )
                    raise
                except Exception as e:
                    if (
                        spec.defer
                        and client_supports_deferred
                        and only_keys is not None
                    ):
                        metrics.deferred_errors += 1
                        message = "A deferred resource could not be resolved"
                        if debug:
                            message = (
                                f"Error loading deferred resource '{spec.key}': {e}"
                            )
                        resource_errors[spec.key] = ResourceErrorDetail(
                            type="ResourceError",
                            message=message,
                        )
                        if diagnostics is not None:
                            diagnostics.finish_resource(
                                diagnostic,
                                result="error",
                                error_type="ResourceError",
                            )
                        return
                    if diagnostics is not None:
                        diagnostics.finish_resource(
                            diagnostic,
                            result="error",
                            error_type="ResourceError",
                        )
                    raise ResourceError(f"Error loading resource '{spec.key}': {e}") from e
                finally:
                    if diagnostics is not None:
                        assert loader_started_at is not None
                        diagnostics.record_loader(
                            diagnostic,
                            duration_ms=(time.perf_counter() - loader_started_at)
                            * 1000.0,
                        )

            try:
                async with anyio.create_task_group() as tg:
                    for spec in pending_misses:
                        tg.start_soon(_resolve_single, spec)
            except BaseExceptionGroup as eg:
                # Unwrap single ResourceError if present
                for exc in eg.exceptions:
                    if isinstance(exc, ResourceError):
                        raise exc from eg
                raise ResourceError(f"Resource resolution failed: {eg}") from eg

            # Store in cache and prepare response
            now = time.monotonic()
            for key, (version, value, spec) in miss_results.items():
                diagnostic = (
                    resource_diagnostics.get(key)
                    if resource_diagnostics is not None
                    else None
                )
                if spec.scope.is_cacheable and spec.ttl > 0:
                    cache_key = cls.get_cache_key(spec)
                    cached_entry = CachedResource(
                        version=version,
                        value=value,
                        expires_at=now + spec.ttl,
                        tags=spec.tags,
                    )
                    try:
                        await cache.set(cache_key, cached_entry, spec.ttl)
                    except Exception:
                        if diagnostics is not None:
                            diagnostics.finish_resource(
                                diagnostic,
                                result="error",
                                error_type="ResourceCacheError",
                            )
                        raise

                client_ver = known_versions.get(key)
                if client_ver == version:
                    # Client already knows this version -> omit
                    metrics.resources_omitted += 1
                    if diagnostics is not None:
                        diagnostics.finish_resource(
                            diagnostic,
                            result="omitted-known",
                            known_version=True,
                        )
                else:
                    metrics.resources_sent += 1
                    resolved_records[key] = ResourceWireRecord(
                        version=version,
                        value=value,
                    )
                    if diagnostics is not None:
                        diagnostics.finish_resource(
                            diagnostic,
                            result="loader",
                            sent=True,
                        )

        metrics.resources_dur_ms = (time.perf_counter() - t0) * 1000.0
        return ResourceResolution(
            resources=resolved_records,
            deferred=deferred_keys,
            errors=resource_errors,
        )
