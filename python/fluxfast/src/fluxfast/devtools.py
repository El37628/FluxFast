"""Bounded, value-free development diagnostics for FluxFast requests."""

from __future__ import annotations

import base64
import json
import math
import secrets
import time
from dataclasses import dataclass, field
from typing import Literal

from .cache import MemoryResourceCache, ResourceCacheBackend

DEVTOOLS_PROTOCOL = "fluxfast-devtools/1"
HEADER_DEVTOOLS = "X-FluxFast-DevTools"
HEADER_DEVTOOLS_TRACE = "X-FluxFast-DevTools-Trace"

# Leave room below common 8 KiB per-header/proxy limits for surrounding syntax.
MAX_DEVTOOLS_TRACE_HEADER_BYTES = 7 * 1024
MAX_DIAGNOSTIC_RESOURCES = 256
MAX_DIAGNOSTIC_MUTATION_KEYS = 100
MAX_DIAGNOSTIC_KEY_LENGTH = 128

ResourceDiagnosticResult = Literal[
    "cache-hit",
    "cache-miss",
    "loader",
    "deferred",
    "omitted-known",
    "error",
]
CacheDiagnosticResult = Literal["hit", "miss", "bypass"]
CacheBackendType = Literal["memory", "redis", "custom"]
MutationRedirectType = Literal["none", "internal", "external"]


def _duration_ms(started_at: float) -> float:
    return max(0.0, (time.perf_counter() - started_at) * 1000.0)


def _finite_duration(value: float) -> float:
    if not math.isfinite(value) or value < 0:
        return 0.0
    return round(value, 3)


def _safe_key(value: str) -> str:
    bounded = value[:MAX_DIAGNOSTIC_KEY_LENGTH]
    return "".join(
        character
        for character in bounded
        if ord(character) >= 0x20 and not 0x7F <= ord(character) <= 0x9F
    )


def classify_cache_backend(cache: ResourceCacheBackend) -> CacheBackendType:
    """Classify built-in cache backends without exposing implementation details."""

    if isinstance(cache, MemoryResourceCache):
        return "memory"
    # Avoid importing the optional Redis implementation for applications that
    # do not install or configure it.
    cache_type = type(cache)
    if (
        cache_type.__name__ == "RedisResourceCache"
        and cache_type.__module__ == "fluxfast.redis_cache"
    ):
        return "redis"
    return "custom"


@dataclass(slots=True)
class ResourceDiagnostic:
    """Safe execution metadata for one logical resource."""

    key: str
    result: ResourceDiagnosticResult
    scope_type: str
    ttl: float
    deferred: bool
    live: bool
    cache_backend: CacheBackendType
    cache_result: CacheDiagnosticResult = "bypass"
    duration_ms: float = 0.0
    cache_ms: float | None = None
    loader_ms: float | None = None
    sent: bool = False
    known_version: bool = False
    error_type: str | None = None
    _started_at: float = field(default_factory=time.perf_counter, repr=False)


@dataclass(slots=True)
class MutationPatchDiagnostic:
    """Counts-only patch metadata for one logical resource."""

    key: str
    operations: dict[str, int]


@dataclass(slots=True)
class MutationDiagnostic:
    """Value-free execution metadata for one completed mutation."""

    handler_ms: float
    invalidation_ms: float
    serialize_ms: float
    patches: list[MutationPatchDiagnostic]
    invalidated: list[str]
    invalidation_count: int
    live_signals: int
    redirect: MutationRedirectType


@dataclass(slots=True)
class RequestDiagnostic:
    """Complete bounded trace for one development-only request."""

    request_id: str
    request_type: Literal["page", "mutation"]
    total_ms: float
    page_ms: float
    resources_ms: float
    serialize_ms: float
    resources: list[ResourceDiagnostic]
    mutation: MutationDiagnostic | None = None
    truncated: bool = False


class RequestDiagnosticCollector:
    """Collect safe metadata only when an opted-in debug request is active."""

    __slots__ = (
        "_mutation",
        "_started_at",
        "request_id",
        "request_type",
        "resources",
        "truncated",
    )

    def __init__(self, request_type: Literal["page", "mutation"]):
        self.request_id = f"ffdev_{secrets.token_hex(8)}"
        self.request_type = request_type
        self.resources: list[ResourceDiagnostic] = []
        self.truncated = False
        self._started_at = time.perf_counter()
        self._mutation: MutationDiagnostic | None = None

    def start_resource(
        self,
        *,
        key: str,
        scope_type: str,
        ttl: float,
        deferred: bool,
        live: bool,
        cache_backend: CacheBackendType,
    ) -> ResourceDiagnostic | None:
        if len(self.resources) >= MAX_DIAGNOSTIC_RESOURCES:
            self.truncated = True
            return None
        diagnostic = ResourceDiagnostic(
            key=_safe_key(key),
            result="cache-miss",
            scope_type=scope_type,
            ttl=float(ttl),
            deferred=deferred,
            live=live,
            cache_backend=cache_backend,
        )
        self.resources.append(diagnostic)
        return diagnostic

    @staticmethod
    def record_cache(
        diagnostic: ResourceDiagnostic | None,
        *,
        hit: bool,
        duration_ms: float,
    ) -> None:
        if diagnostic is None:
            return
        diagnostic.cache_result = "hit" if hit else "miss"
        diagnostic.cache_ms = _finite_duration(duration_ms)

    @staticmethod
    def record_loader(
        diagnostic: ResourceDiagnostic | None,
        *,
        duration_ms: float,
    ) -> None:
        if diagnostic is not None:
            diagnostic.loader_ms = _finite_duration(duration_ms)

    @staticmethod
    def finish_resource(
        diagnostic: ResourceDiagnostic | None,
        *,
        result: ResourceDiagnosticResult,
        sent: bool = False,
        known_version: bool = False,
        error_type: Literal[
            "ResourceError",
            "ResourceContractError",
            "ResourceCacheError",
        ]
        | None = None,
    ) -> None:
        if diagnostic is None:
            return
        diagnostic.result = result
        diagnostic.sent = sent
        diagnostic.known_version = known_version
        diagnostic.error_type = error_type
        diagnostic.duration_ms = _finite_duration(
            _duration_ms(diagnostic._started_at)
        )

    def build(
        self,
        *,
        page_ms: float,
        resources_ms: float,
        serialize_ms: float,
    ) -> RequestDiagnostic:
        return RequestDiagnostic(
            request_id=self.request_id,
            request_type=self.request_type,
            total_ms=_finite_duration(_duration_ms(self._started_at)),
            page_ms=_finite_duration(page_ms),
            resources_ms=_finite_duration(resources_ms),
            serialize_ms=_finite_duration(serialize_ms),
            resources=list(self.resources),
            mutation=self._mutation,
            truncated=self.truncated,
        )

    def record_mutation(
        self,
        *,
        handler_ms: float,
        invalidation_ms: float,
        serialize_ms: float,
        patches: dict[str, list[dict[str, object]]] | None,
        invalidated: list[str] | None,
        live_signals: int,
        redirect: MutationRedirectType,
    ) -> None:
        """Record a counts-only mutation summary without retaining patch values."""

        self.request_type = "mutation"
        patch_items = list((patches or {}).items())
        invalidated_keys = list(invalidated or ())
        if (
            len(patch_items) > MAX_DIAGNOSTIC_MUTATION_KEYS
            or len(invalidated_keys) > MAX_DIAGNOSTIC_MUTATION_KEYS
        ):
            self.truncated = True

        patch_diagnostics: list[MutationPatchDiagnostic] = []
        for key, operations in patch_items[:MAX_DIAGNOSTIC_MUTATION_KEYS]:
            counts: dict[str, int] = {}
            for operation in operations:
                operation_name = operation.get("op")
                if isinstance(operation_name, str):
                    safe_operation = _safe_key(operation_name)
                    counts[safe_operation] = counts.get(safe_operation, 0) + 1
            patch_diagnostics.append(
                MutationPatchDiagnostic(
                    key=_safe_key(key),
                    operations=dict(sorted(counts.items())),
                )
            )

        self._mutation = MutationDiagnostic(
            handler_ms=_finite_duration(handler_ms),
            invalidation_ms=_finite_duration(invalidation_ms),
            serialize_ms=_finite_duration(serialize_ms),
            patches=patch_diagnostics,
            invalidated=[
                _safe_key(key)
                for key in invalidated_keys[:MAX_DIAGNOSTIC_MUTATION_KEYS]
            ],
            invalidation_count=len(invalidated_keys),
            live_signals=max(0, live_signals),
            redirect=redirect,
        )


def diagnostics_requested(*, debug: bool, header_value: str | None) -> bool:
    """Require server debug mode and an exact client opt-in header."""

    return debug and header_value == "1"


def _resource_payload(resource: ResourceDiagnostic) -> dict[str, object]:
    payload: dict[str, object] = {
        "key": resource.key,
        "result": resource.result,
        "durationMs": _finite_duration(resource.duration_ms),
        "scope": resource.scope_type,
        "ttl": resource.ttl,
        "deferred": resource.deferred,
        "live": resource.live,
        "cacheBackend": resource.cache_backend,
        "cacheResult": resource.cache_result,
        "sent": resource.sent,
        "knownVersion": resource.known_version,
    }
    if resource.cache_ms is not None:
        payload["cacheMs"] = _finite_duration(resource.cache_ms)
    if resource.loader_ms is not None:
        payload["loaderMs"] = _finite_duration(resource.loader_ms)
    if resource.error_type is not None:
        payload["errorType"] = resource.error_type
    return payload


def _request_payload(trace: RequestDiagnostic) -> dict[str, object]:
    payload: dict[str, object] = {
        "protocol": DEVTOOLS_PROTOCOL,
        "requestId": trace.request_id,
        "type": trace.request_type,
        "durationMs": _finite_duration(trace.total_ms),
        "truncated": trace.truncated,
    }
    if trace.request_type == "mutation" and trace.mutation is not None:
        mutation = trace.mutation
        payload.update(
            {
                "handlerMs": _finite_duration(mutation.handler_ms),
                "invalidationMs": _finite_duration(mutation.invalidation_ms),
                "serializeMs": _finite_duration(mutation.serialize_ms),
                "patches": [
                    {
                        "key": patch.key,
                        "operations": patch.operations,
                    }
                    for patch in mutation.patches
                ],
                "invalidated": mutation.invalidated,
                "invalidationCount": mutation.invalidation_count,
                "liveSignals": mutation.live_signals,
                "redirect": mutation.redirect,
            }
        )
    else:
        payload.update(
            {
                "pageMs": _finite_duration(trace.page_ms),
                "resourcesMs": _finite_duration(trace.resources_ms),
                "serializeMs": _finite_duration(trace.serialize_ms),
                "resources": [
                    _resource_payload(resource) for resource in trace.resources
                ],
            }
        )
    return payload


def encode_diagnostic_trace(
    trace: RequestDiagnostic,
    *,
    maximum_bytes: int = MAX_DEVTOOLS_TRACE_HEADER_BYTES,
) -> str | None:
    """Encode a trace under a strict header bound, dropping resource details first."""

    if maximum_bytes <= 0:
        return None
    payload = _request_payload(trace)

    while True:
        try:
            encoded_json = json.dumps(
                payload,
                separators=(",", ":"),
                ensure_ascii=True,
                allow_nan=False,
            ).encode("utf-8")
        except (TypeError, ValueError, OverflowError):
            return None
        encoded = base64.urlsafe_b64encode(encoded_json).rstrip(b"=")
        if len(encoded) <= maximum_bytes:
            return encoded.decode("ascii")
        resources = payload.get("resources")
        patches = payload.get("patches")
        invalidated = payload.get("invalidated")
        if isinstance(resources, list) and resources:
            resources.pop()
        elif isinstance(patches, list) and patches:
            patches.pop()
        elif isinstance(invalidated, list) and invalidated:
            invalidated.pop()
        else:
            return None
        payload["truncated"] = True
