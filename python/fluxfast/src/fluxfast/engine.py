"""Parallel resource resolution engine using AnyIO structured concurrency."""

import inspect
import time
from typing import Any

import anyio

from .cache import CachedResource, ResourceCacheBackend
from .errors import ResourceError
from .page import Page
from .protocol import ResourceWireRecord
from .resource import ResourceSpec
from .serialization import compute_version, to_jsonable
from .timing import TimingMetrics


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
    ) -> dict[str, ResourceWireRecord[Any]]:
        t0 = time.perf_counter()

        specs_to_process = page.resources
        if only_keys is not None:
            specs_to_process = [s for s in specs_to_process if s.key in only_keys]

        resolved_records: dict[str, ResourceWireRecord[Any]] = {}
        pending_misses: list[ResourceSpec] = []

        # 1. Evaluate cache hits
        for spec in specs_to_process:
            if spec.scope.is_cacheable and spec.ttl > 0:
                cache_key = cls.get_cache_key(spec)
                cached = await cache.get(cache_key)
                if cached is not None:
                    metrics.cache_hits += 1
                    # Compare with client-known version
                    client_ver = known_versions.get(spec.key)
                    if client_ver == cached.version:
                        # Client already has identical version -> omit
                        metrics.resources_omitted += 1
                    else:
                        # Client has different or no version -> send cached record
                        metrics.resources_sent += 1
                        resolved_records[spec.key] = ResourceWireRecord(
                            version=cached.version,
                            value=cached.value,
                        )
                    continue

            # Cache miss or uncacheable
            metrics.cache_misses += 1
            pending_misses.append(spec)

        # 2. Concurrently resolve misses
        if pending_misses:
            miss_results: dict[str, tuple[str, Any, ResourceSpec]] = {}

            async def _resolve_single(spec: ResourceSpec) -> None:
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

                    wire_value = to_jsonable(val)
                    ver = compute_version(wire_value)
                    miss_results[spec.key] = (ver, wire_value, spec)
                except Exception as e:
                    raise ResourceError(f"Error loading resource '{spec.key}': {e}") from e

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
                if spec.scope.is_cacheable and spec.ttl > 0:
                    cache_key = cls.get_cache_key(spec)
                    cached_entry = CachedResource(
                        version=version,
                        value=value,
                        expires_at=now + spec.ttl,
                        tags=spec.tags,
                    )
                    await cache.set(cache_key, cached_entry, spec.ttl)

                client_ver = known_versions.get(key)
                if client_ver == version:
                    # Client already knows this version -> omit
                    metrics.resources_omitted += 1
                else:
                    metrics.resources_sent += 1
                    resolved_records[key] = ResourceWireRecord(
                        version=version,
                        value=value,
                    )

        metrics.resources_dur_ms = (time.perf_counter() - t0) * 1000.0
        return resolved_records
