"""Minimal liveness and dependency-aware readiness for FluxFast applications."""

from __future__ import annotations

import inspect
from dataclasses import dataclass
from typing import Final

import anyio
from fastapi import FastAPI
from fastapi.responses import JSONResponse

HEALTH_PATH: Final = "/_fluxfast/healthz"
READINESS_PATH: Final = "/_fluxfast/readyz"
DEFAULT_HEALTH_CHECK_TIMEOUT: Final = 1.0


@dataclass(slots=True)
class ProductionHealthState:
    """Track startup, shutdown, and optional FluxFast-owned dependencies."""

    dependencies: tuple[object, ...]
    dependency_timeout: float = DEFAULT_HEALTH_CHECK_TIMEOUT
    initialized: bool = False
    shutting_down: bool = False

    async def startup(self) -> None:
        """Mark FluxFast initialization complete after application startup."""

        self.initialized = True

    async def shutdown(self) -> None:
        """Stop reporting readiness before owned dependencies are closed."""

        self.shutting_down = True

    async def ready(self) -> bool:
        """Return whether lifecycle state and checkable dependencies are ready."""

        if not self.initialized or self.shutting_down:
            return False
        for dependency in self.dependencies:
            healthcheck = getattr(dependency, "healthcheck", None)
            if not callable(healthcheck):
                continue
            try:
                with anyio.fail_after(self.dependency_timeout):
                    result = healthcheck()
                    if inspect.isawaitable(result):
                        result = await result
            except Exception:  # noqa: BLE001
                return False
            if result is not True:
                return False
        return True


def install_production_health(
    app: FastAPI,
    *dependencies: object,
) -> ProductionHealthState:
    """Install reserved health routes and lifecycle markers on one FastAPI app."""

    _reject_reserved_route_conflicts(app)
    state = ProductionHealthState(tuple(dependencies))

    async def healthz() -> JSONResponse:
        return JSONResponse(
            {"status": "ok"},
            headers={"Cache-Control": "no-store"},
        )

    async def readyz() -> JSONResponse:
        if await state.ready():
            return JSONResponse(
                {"status": "ready"},
                headers={"Cache-Control": "no-store"},
            )
        return JSONResponse(
            {"status": "not_ready"},
            status_code=503,
            headers={"Cache-Control": "no-store"},
        )

    app.add_api_route(
        HEALTH_PATH,
        healthz,
        methods=["GET"],
        include_in_schema=False,
        name="fluxfast_healthz",
    )
    app.add_api_route(
        READINESS_PATH,
        readyz,
        methods=["GET"],
        include_in_schema=False,
        name="fluxfast_readyz",
    )
    app.router.add_event_handler("startup", state.startup)
    app.router.add_event_handler("shutdown", state.shutdown)
    app.state.fluxfast_health = state
    return state


def _reject_reserved_route_conflicts(app: FastAPI) -> None:
    for route in app.routes:
        path = getattr(route, "path", None)
        methods = getattr(route, "methods", None) or set()
        if path in {HEALTH_PATH, READINESS_PATH} and "GET" in methods:
            raise ValueError(f"{path} is reserved for FluxFast runtime health")
