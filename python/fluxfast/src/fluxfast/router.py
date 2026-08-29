"""FluxFast FastAPI router extension with page route decorator."""

import inspect
import time
from collections.abc import Callable
from functools import wraps
from typing import Any

from fastapi import APIRouter, Request, Response
from fastapi.responses import JSONResponse

from .cache import MemoryResourceCache, ResourceCacheBackend
from .capabilities import CAPABILITY_DEFERRED_RESOURCES, client_supports
from .engine import ResourceEngine
from .headers import (
    HEADER_FLUXFAST,
    HEADER_KNOWN,
    HEADER_ONLY,
    HEADER_PROTOCOL,
    HEADER_SERVER_TIMING,
    parse_known_header,
    parse_only_header,
    validate_protocol_header,
)
from .mutation import InvalidateResource, MutationResult
from .page import Page
from .protocol import (
    PROTOCOL_MEDIA_TYPE,
    PROTOCOL_VERSION,
    PageDescriptor,
    PageEnvelope,
)
from .timing import TimingMetrics

_DEFAULT_CACHE = MemoryResourceCache()


class FluxRouter(APIRouter):
    """FastAPI APIRouter subclass adding FluxFast page routing capabilities."""

    def page(self, path: str, *args: Any, **kwargs: Any) -> Callable[..., Any]:
        """Register a FluxFast server-driven page route."""

        def decorator(func: Callable[..., Any]) -> Callable[..., Any]:
            # Signature preservation for FastAPI dependency injection
            sig = inspect.signature(func)
            params = list(sig.parameters.values())

            # Ensure 'request' is present in endpoint signature so FastAPI injects it
            request_param = next((p for p in params if p.annotation is Request), None)
            has_request = request_param is not None
            injected_request_name = request_param.name if request_param else "_flux_request"

            if not has_request:
                while injected_request_name in sig.parameters:
                    injected_request_name = f"_{injected_request_name}"
                # Add request parameter with default or annotation for FastAPI
                new_param = inspect.Parameter(
                    injected_request_name,
                    inspect.Parameter.KEYWORD_ONLY,
                    default=None,
                    annotation=Request,
                )
                params.append(new_param)
                wrapper_sig = sig.replace(parameters=params)
            else:
                wrapper_sig = sig

            @wraps(func)
            async def endpoint_wrapper(*fn_args: Any, **fn_kwargs: Any) -> Response:
                # Extract request object
                request: Request | None = fn_kwargs.get(injected_request_name)
                if request is None:
                    for arg in fn_args:
                        if isinstance(arg, Request):
                            request = arg
                            break

                # Remove synthetic request kwarg if we injected it
                call_kwargs = dict(fn_kwargs)
                if not has_request and injected_request_name in call_kwargs:
                    del call_kwargs[injected_request_name]

                metrics = TimingMetrics()
                t0 = time.perf_counter()
                assert request is not None, "Request must be present for FluxFast page rendering"
                validate_protocol_header(request)

                # Execute route function (handles dependencies and page construction)
                if inspect.iscoroutinefunction(func):
                    result = await func(*fn_args, **call_kwargs)
                else:
                    result = func(*fn_args, **call_kwargs)
                    if inspect.isawaitable(result):
                        result = await result

                metrics.page_dur_ms = (time.perf_counter() - t0) * 1000.0

                if isinstance(result, Page):
                    cache: ResourceCacheBackend = getattr(
                        request.app.state, "fluxfast_cache", _DEFAULT_CACHE
                    )

                    known_versions = parse_known_header(request.headers.get(HEADER_KNOWN))
                    only_keys = parse_only_header(request.headers.get(HEADER_ONLY))
                    supports_deferred = client_supports(
                        request, CAPABILITY_DEFERRED_RESOURCES
                    )

                    resolution = await ResourceEngine.resolve_page_resources(
                        page=result,
                        known_versions=known_versions,
                        only_keys=only_keys,
                        cache=cache,
                        metrics=metrics,
                        client_supports_deferred=supports_deferred,
                    )

                    t_ser = time.perf_counter()
                    requested_url = request.url.path
                    if request.url.query:
                        requested_url = f"{requested_url}?{request.url.query}"

                    envelope = PageEnvelope(
                        protocol=PROTOCOL_VERSION,
                        page=PageDescriptor(
                            component=result.component,
                            url=requested_url,
                            meta=result.meta,
                        ),
                        resources=resolution.resources,
                        resourceKeys=(
                            [spec.key for spec in result.resources]
                            if supports_deferred
                            else None
                        ),
                        deferred=(
                            resolution.deferred
                            if supports_deferred and resolution.deferred
                            else None
                        ),
                    )
                    payload = envelope.model_dump(mode="json", exclude_none=True)
                    metrics.serialize_dur_ms = (time.perf_counter() - t_ser) * 1000.0

                    headers = {
                        HEADER_FLUXFAST: "1",
                        HEADER_PROTOCOL: "1",
                        HEADER_SERVER_TIMING: metrics.to_server_timing_header(),
                        "X-FluxFast-Cache-Hits": str(metrics.cache_hits),
                        "X-FluxFast-Cache-Misses": str(metrics.cache_misses),
                        "X-FluxFast-Resources-Sent": str(metrics.resources_sent),
                    }

                    return JSONResponse(
                        content=payload,
                        media_type=PROTOCOL_MEDIA_TYPE,
                        headers=headers,
                    )

                elif isinstance(result, MutationResult):
                    assert request is not None
                    cache = getattr(request.app.state, "fluxfast_cache", _DEFAULT_CACHE)
                    if result.invalidate:
                        for inv in result.invalidate:
                            if isinstance(inv, InvalidateResource) and inv.scope is not None:
                                key = f"{inv.scope.fingerprint()}::{inv.key}"
                                await cache.delete(key)

                    envelope = result.to_envelope()
                    headers = {
                        HEADER_FLUXFAST: "1",
                        HEADER_PROTOCOL: "1",
                    }
                    if result.external_redirect:
                        headers["X-FluxFast-External-Redirect"] = result.external_redirect

                    return JSONResponse(
                        content=envelope.model_dump(mode="json", exclude_none=True),
                        media_type=PROTOCOL_MEDIA_TYPE,
                        headers=headers,
                    )

                return result

            endpoint_wrapper.__signature__ = wrapper_sig  # type: ignore

            # Register with standard FastAPI router
            self.add_api_route(
                path,
                endpoint_wrapper,
                *args,
                methods=["GET"],
                **kwargs,
            )
            return func

        return decorator

    def mutation(self, path: str, methods: list[str] | None = None, *args: Any, **kwargs: Any) -> Callable[..., Any]:
        """Register a FluxFast mutation route."""
        if methods is None:
            methods = ["POST"]

        def decorator(func: Callable[..., Any]) -> Callable[..., Any]:
            sig = inspect.signature(func)
            params = list(sig.parameters.values())

            request_param = next((p for p in params if p.annotation is Request), None)
            has_request = request_param is not None
            injected_request_name = request_param.name if request_param else "_flux_request"

            if not has_request:
                while injected_request_name in sig.parameters:
                    injected_request_name = f"_{injected_request_name}"
                new_param = inspect.Parameter(
                    injected_request_name,
                    inspect.Parameter.KEYWORD_ONLY,
                    default=None,
                    annotation=Request,
                )
                params.append(new_param)
                wrapper_sig = sig.replace(parameters=params)
            else:
                wrapper_sig = sig

            @wraps(func)
            async def mutation_wrapper(*fn_args: Any, **fn_kwargs: Any) -> Response:
                request: Request | None = fn_kwargs.get(injected_request_name)
                if request is None:
                    for arg in fn_args:
                        if isinstance(arg, Request):
                            request = arg
                            break

                call_kwargs = dict(fn_kwargs)
                if not has_request and injected_request_name in call_kwargs:
                    del call_kwargs[injected_request_name]

                assert request is not None, "Request must be present for FluxFast mutation rendering"
                validate_protocol_header(request)

                if inspect.iscoroutinefunction(func):
                    result = await func(*fn_args, **call_kwargs)
                else:
                    result = func(*fn_args, **call_kwargs)
                    if inspect.isawaitable(result):
                        result = await result

                if isinstance(result, MutationResult):
                    cache = getattr(request.app.state, "fluxfast_cache", _DEFAULT_CACHE)
                    if result.invalidate:
                        for inv in result.invalidate:
                            if isinstance(inv, InvalidateResource) and inv.scope is not None:
                                key = f"{inv.scope.fingerprint()}::{inv.key}"
                                await cache.delete(key)

                    envelope = result.to_envelope()
                    headers = {
                        HEADER_FLUXFAST: "1",
                        HEADER_PROTOCOL: "1",
                    }
                    if result.external_redirect:
                        headers["X-FluxFast-External-Redirect"] = result.external_redirect

                    return JSONResponse(
                        content=envelope.model_dump(mode="json", exclude_none=True),
                        media_type=PROTOCOL_MEDIA_TYPE,
                        headers=headers,
                    )
                return result

            mutation_wrapper.__signature__ = wrapper_sig  # type: ignore

            self.add_api_route(
                path,
                mutation_wrapper,
                *args,
                methods=methods,
                **kwargs,
            )
            return func

        return decorator
