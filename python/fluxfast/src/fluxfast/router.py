"""FluxFast FastAPI router extension with page route decorator."""

import inspect
import time
from collections.abc import Callable
from functools import wraps
from typing import Any

from fastapi import APIRouter, Request, Response
from fastapi.responses import JSONResponse
from starlette.responses import StreamingResponse

from .cache import MemoryResourceCache, ResourceCacheBackend
from .capabilities import (
    CAPABILITY_DEFERRED_RESOURCES,
    CAPABILITY_LIVE_RESOURCES,
    client_supports,
)
from .engine import ResourceEngine
from .errors import ProtocolError
from .headers import (
    HEADER_CLIENT_ID,
    HEADER_DEFERRED_ERRORS,
    HEADER_DEFERRED_PENDING,
    HEADER_FLUXFAST,
    HEADER_KNOWN,
    HEADER_LIVE_KEYS,
    HEADER_LIVE_RESOURCES,
    HEADER_ONLY,
    HEADER_PROTOCOL,
    HEADER_SERVER_TIMING,
    is_live_request,
    parse_known_header,
    parse_live_keys_header,
    parse_only_header,
    validate_live_client_id,
    validate_protocol_header,
)
from .live import (
    DEFAULT_LIVE_HEARTBEAT_INTERVAL,
    DEFAULT_LIVE_MAX_CONNECTION_AGE,
    LiveCoordinator,
    MemoryLiveBroker,
    iter_live_events,
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


def _get_live_coordinator(
    request: Request,
    cache: ResourceCacheBackend,
) -> LiveCoordinator:
    live: LiveCoordinator | None = getattr(
        request.app.state,
        "fluxfast_live",
        None,
    )
    if live is None:
        live = LiveCoordinator(cache, MemoryLiveBroker())
        request.app.state.fluxfast_live = live
    return live


async def _render_mutation_result(
    request: Request,
    result: MutationResult,
    *,
    origin_client_id: str | None,
) -> JSONResponse:
    cache: ResourceCacheBackend = getattr(
        request.app.state,
        "fluxfast_cache",
        _DEFAULT_CACHE,
    )
    live = _get_live_coordinator(request, cache)
    for invalidation in result.invalidate or ():
        if not isinstance(invalidation, InvalidateResource):
            continue
        resource_scope = invalidation.scope
        if resource_scope is None:
            continue
        if resource_scope.is_cacheable:
            await live.invalidate(
                invalidation.key,
                scope=resource_scope,
                origin_client_id=origin_client_id,
            )
        else:
            await cache.delete(
                f"{resource_scope.fingerprint()}::{invalidation.key}"
            )

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
                origin_client_id = validate_live_client_id(
                    request.headers.get(HEADER_CLIENT_ID)
                )

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

                    if is_live_request(request):
                        if not client_supports(request, CAPABILITY_LIVE_RESOURCES):
                            raise ProtocolError(
                                "Live requests require the live-resources capability"
                            )
                        requested_live_keys = parse_live_keys_header(
                            request.headers.get(HEADER_LIVE_KEYS)
                        )
                        live = _get_live_coordinator(request, cache)
                        subscription = live.resolve_subscription(
                            result,
                            requested_live_keys,
                        )
                        if not subscription.keys:
                            raise ProtocolError(
                                "No requested live resources are declared by this page"
                            )
                        stream = iter_live_events(
                            live,
                            subscription,
                            heartbeat_interval=float(
                                getattr(
                                    request.app.state,
                                    "fluxfast_live_heartbeat_interval",
                                    DEFAULT_LIVE_HEARTBEAT_INTERVAL,
                                )
                            ),
                            max_connection_age=float(
                                getattr(
                                    request.app.state,
                                    "fluxfast_live_max_connection_age",
                                    DEFAULT_LIVE_MAX_CONNECTION_AGE,
                                )
                            ),
                        )
                        return StreamingResponse(
                            stream,
                            media_type="text/event-stream",
                            headers={
                                "Cache-Control": "no-cache, no-transform",
                                "X-Accel-Buffering": "no",
                                HEADER_FLUXFAST: "1",
                                HEADER_PROTOCOL: "1",
                            },
                        )

                    known_versions = parse_known_header(request.headers.get(HEADER_KNOWN))
                    only_keys = parse_only_header(request.headers.get(HEADER_ONLY))
                    supports_deferred = client_supports(
                        request, CAPABILITY_DEFERRED_RESOURCES
                    )
                    supports_live = client_supports(request, CAPABILITY_LIVE_RESOURCES)
                    live_keys = (
                        [spec.key for spec in result.resources if spec.live]
                        if supports_live
                        else []
                    )

                    resolution = await ResourceEngine.resolve_page_resources(
                        page=result,
                        known_versions=known_versions,
                        only_keys=only_keys,
                        cache=cache,
                        metrics=metrics,
                        client_supports_deferred=supports_deferred,
                        debug=bool(
                            getattr(request.app.state, "fluxfast_debug", False)
                        ),
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
                        live=(live_keys or None),
                        resourceErrors=(resolution.errors or None),
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
                        HEADER_DEFERRED_PENDING: str(len(resolution.deferred)),
                        HEADER_DEFERRED_ERRORS: str(len(resolution.errors)),
                    }
                    if supports_live:
                        headers[HEADER_LIVE_RESOURCES] = str(len(live_keys))

                    return JSONResponse(
                        content=payload,
                        media_type=PROTOCOL_MEDIA_TYPE,
                        headers=headers,
                    )

                elif isinstance(result, MutationResult):
                    assert request is not None
                    return await _render_mutation_result(
                        request,
                        result,
                        origin_client_id=origin_client_id,
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
                origin_client_id = validate_live_client_id(
                    request.headers.get(HEADER_CLIENT_ID)
                )

                if inspect.iscoroutinefunction(func):
                    result = await func(*fn_args, **call_kwargs)
                else:
                    result = func(*fn_args, **call_kwargs)
                    if inspect.isawaitable(result):
                        result = await result

                if isinstance(result, MutationResult):
                    return await _render_mutation_result(
                        request,
                        result,
                        origin_client_id=origin_client_id,
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
