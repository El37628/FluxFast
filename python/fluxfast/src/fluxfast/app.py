"""FluxFast FastAPI application integration and lifecycle management."""

import inspect
import math
from collections.abc import Callable
from typing import Any, TypeVar

from fastapi import FastAPI, Request
from fastapi.exception_handlers import request_validation_exception_handler
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from ._validation_locations import _normalize_validation_location
from .cache import MemoryResourceCache, ResourceCacheBackend
from .contract import ContractMode, ResourceContract, TypeContract
from .errors import FluxFastError, ProtocolError, ResourceError
from .headers import HEADER_FLUXFAST, HEADER_PROTOCOL, is_fluxfast_request
from .live import (
    DEFAULT_LIVE_HEARTBEAT_INTERVAL,
    DEFAULT_LIVE_MAX_CONNECTION_AGE,
    LiveBroker,
    LiveCoordinator,
    LiveMetrics,
    MemoryLiveBroker,
)
from .production.health import install_production_health
from .protocol import PROTOCOL_MEDIA_TYPE, PROTOCOL_VERSION, ErrorDetail, ErrorEnvelope
from .router import FluxRouter
from .schema_registry import SchemaRegistry

T = TypeVar("T")

_SAFE_VALIDATION_MESSAGES = {
    # Pydantic interpolates the submitted discriminator value into this message.
    "union_tag_invalid": "Invalid discriminator value",
}


def _validation_message(error: dict[str, Any]) -> str:
    error_type = error.get("type")
    if type(error_type) is str and error_type in _SAFE_VALIDATION_MESSAGES:
        return _SAFE_VALIDATION_MESSAGES[error_type]

    message = error.get("msg", "Invalid value")
    return message if type(message) is str else "Invalid value"


class FluxFast:
    """Main application integrator configuring FastAPI with FluxFast support."""

    def __init__(
        self,
        app: FastAPI,
        cache: ResourceCacheBackend | None = None,
        debug: bool = False,
        broker: LiveBroker | None = None,
        live_max_connection_age: float = DEFAULT_LIVE_MAX_CONNECTION_AGE,
        live_heartbeat_interval: float = DEFAULT_LIVE_HEARTBEAT_INTERVAL,
        *,
        live_broker: LiveBroker | None = None,
    ):
        if broker is not None and live_broker is not None:
            raise ValueError("Pass either broker or live_broker, not both")
        for name, value in (
            ("live_max_connection_age", live_max_connection_age),
            ("live_heartbeat_interval", live_heartbeat_interval),
        ):
            if (
                isinstance(value, bool)
                or not isinstance(value, (int, float))
                or not math.isfinite(value)
                or value <= 0
            ):
                raise ValueError(f"{name} must be a finite positive number")
        self.app = app
        self.schema_registry = SchemaRegistry()
        self.cache = cache if cache is not None else MemoryResourceCache()
        self.live_metrics = LiveMetrics()
        configured_broker = (
            live_broker
            if live_broker is not None
            else broker
            if broker is not None
            else MemoryLiveBroker(metrics=self.live_metrics)
        )
        self.live = LiveCoordinator(
            self.cache,
            configured_broker,
            metrics=self.live_metrics,
        )
        self.debug = debug
        self.live_max_connection_age = float(live_max_connection_age)
        self.live_heartbeat_interval = float(live_heartbeat_interval)
        self._closed = False
        self.health = install_production_health(
            self.app,
            self.cache,
            configured_broker,
        )

        # Attach cache to FastAPI app state
        self.app.state.fluxfast_cache = self.cache
        self.app.state.fluxfast_debug = self.debug
        self.app.state.fluxfast_schema_registry = self.schema_registry
        self.app.state.fluxfast_live = self.live
        self.app.state.fluxfast_live_metrics = self.live_metrics
        self.app.state.fluxfast_live_max_connection_age = self.live_max_connection_age
        self.app.state.fluxfast_live_heartbeat_interval = self.live_heartbeat_interval
        self.app.router.add_event_handler("shutdown", self.close)

        # Setup exception handlers
        self._setup_exception_handlers()

        # Shared router
        self.router = FluxRouter()

    def define_resource(self, key: str, annotation: type[T]) -> ResourceContract[T]:
        """Define the authoritative typed contract for a logical resource key."""

        return self.schema_registry.define_resource(key, annotation)

    def define_type(
        self,
        name: str,
        annotation: Any,
        *,
        mode: ContractMode = "serialization",
    ) -> TypeContract[Any]:
        """Define an application contract independent of a resource."""

        return self.schema_registry.define_type(name, annotation, mode=mode)

    async def close(self) -> None:
        """Close live transport and an optionally closeable cache exactly once."""

        if self._closed:
            return
        self._closed = True
        await self.health.shutdown()
        try:
            await self.live.close()
        finally:
            close_cache = getattr(self.cache, "close", None)
            if callable(close_cache):
                result = close_cache()
                if inspect.isawaitable(result):
                    await result

    def _setup_exception_handlers(self) -> None:
        @self.app.exception_handler(RequestValidationError)
        async def validation_exception_handler(request: Request, exc: RequestValidationError) -> JSONResponse:
            if not is_fluxfast_request(request):
                return await request_validation_exception_handler(request, exc)

            # Map Pydantic validation errors to structured dictionary
            field_errors: dict[str, list[str]] = {}
            for error in exc.errors():
                loc = error.get("loc", ())
                field_name = _normalize_validation_location(
                    loc,
                    route=request.scope.get("route"),
                    error_type=error.get("type"),
                )
                msg = _validation_message(error)
                field_errors.setdefault(field_name, []).append(msg)

            envelope = ErrorEnvelope(
                protocol=PROTOCOL_VERSION,
                error=ErrorDetail(
                    type="ValidationError",
                    message="Request validation failed",
                    details=field_errors,
                ),
            )
            return JSONResponse(
                status_code=422,
                content=envelope.model_dump(mode="json"),
                media_type=PROTOCOL_MEDIA_TYPE,
                headers={
                    HEADER_FLUXFAST: "1",
                    HEADER_PROTOCOL: "1",
                },
            )

        @self.app.exception_handler(FluxFastError)
        async def fluxfast_exception_handler(request: Request, exc: FluxFastError) -> JSONResponse:
            status_code = 409 if isinstance(exc, ProtocolError) else 500
            public_message = exc.message
            public_details = exc.details
            if isinstance(exc, ResourceError) and not self.debug:
                public_message = "A resource could not be resolved"
                public_details = None

            envelope = ErrorEnvelope(
                protocol=PROTOCOL_VERSION,
                error=ErrorDetail(
                    type=type(exc).__name__,
                    message=public_message,
                    details=public_details,
                ),
            )
            return JSONResponse(
                status_code=status_code,
                content=envelope.model_dump(mode="json"),
                media_type=PROTOCOL_MEDIA_TYPE,
                headers={HEADER_FLUXFAST: "1", HEADER_PROTOCOL: "1"},
            )

    def page(self, path: str, *args: Any, **kwargs: Any) -> Callable[..., Any]:
        """Define a page directly on the integrated FastAPI application."""
        register = self.router.page(path, *args, **kwargs)

        def decorator(func: Callable[..., Any]) -> Callable[..., Any]:
            route_count = len(self.router.routes)
            registered = register(func)
            self.app.router.routes.extend(self.router.routes[route_count:])
            return registered

        return decorator

    def mutation(
        self,
        path: str,
        methods: list[str] | None = None,
        *args: Any,
        **kwargs: Any,
    ) -> Callable[..., Any]:
        """Define a mutation directly on the integrated FastAPI application."""
        register = self.router.mutation(path, methods, *args, **kwargs)

        def decorator(func: Callable[..., Any]) -> Callable[..., Any]:
            route_count = len(self.router.routes)
            registered = register(func)
            self.app.router.routes.extend(self.router.routes[route_count:])
            return registered

        return decorator
