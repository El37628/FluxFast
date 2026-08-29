"""FluxFast FastAPI application integration and lifecycle management."""

from collections.abc import Callable
from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from .cache import MemoryResourceCache, ResourceCacheBackend
from .errors import FluxFastError, ProtocolError, ResourceError
from .headers import HEADER_FLUXFAST, HEADER_PROTOCOL, is_fluxfast_request
from .protocol import PROTOCOL_MEDIA_TYPE, PROTOCOL_VERSION, ErrorDetail, ErrorEnvelope
from .router import FluxRouter


class FluxFast:
    """Main application integrator configuring FastAPI with FluxFast support."""

    def __init__(
        self,
        app: FastAPI,
        cache: ResourceCacheBackend | None = None,
        debug: bool = False,
    ):
        self.app = app
        self.cache = cache if cache is not None else MemoryResourceCache()
        self.debug = debug

        # Attach cache to FastAPI app state
        self.app.state.fluxfast_cache = self.cache
        self.app.state.fluxfast_debug = self.debug

        # Setup exception handlers
        self._setup_exception_handlers()

        # Shared router
        self.router = FluxRouter()

    def _setup_exception_handlers(self) -> None:
        @self.app.exception_handler(RequestValidationError)
        async def validation_exception_handler(request: Request, exc: RequestValidationError) -> JSONResponse:
            # Map Pydantic validation errors to structured dictionary
            field_errors: dict[str, list[str]] = {}
            for error in exc.errors():
                loc = error.get("loc", ())
                # Extract field name (skip 'body', 'query', etc. if nested)
                field_name = str(loc[-1]) if loc else "general"
                msg = error.get("msg", "Invalid value")
                if field_name not in field_errors:
                    field_errors[field_name] = []
                field_errors[field_name].append(msg)

            if is_fluxfast_request(request):
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

            # Fallback standard response for non-Flux requests
            return JSONResponse(
                status_code=422,
                content={"detail": exc.errors()},
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
