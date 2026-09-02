"""Concrete FastAPI and Next.js production runtime construction."""

from __future__ import annotations

import os
import sys
from pathlib import Path

from .config import ProductionConfig
from .errors import ProductionBuildMissingError, ProductionValidationError
from .frontend import production_frontend_command
from .process import ManagedProcess
from .supervisor import (
    ProductionSupervisor,
    ReadinessProbe,
    http_readiness_probe,
    tcp_readiness_probe,
)


def create_production_supervisor(config: ProductionConfig) -> ProductionSupervisor:
    """Validate a production project and construct its two-child supervisor."""

    frontend = config.frontend.resolve()
    _validate_frontend(frontend)

    backend_connection_host = _connection_host(config.backend_host)
    frontend_connection_host = _connection_host(config.host)
    backend_url = _http_url(backend_connection_host, config.backend_port)

    backend = ManagedProcess(
        "FastAPI",
        [
            sys.executable,
            "-m",
            "uvicorn",
            config.app,
            "--host",
            config.backend_host,
            "--port",
            str(config.backend_port),
            "--workers",
            str(config.workers),
        ],
    )

    frontend_environment = os.environ.copy()
    frontend_environment["NODE_ENV"] = "production"
    frontend_environment["FLUXFAST_BACKEND_URL"] = backend_url
    frontend_environment["FLUXFAST_PRODUCTION_START"] = "1"
    frontend_environment.pop("NEXT_PUBLIC_FLUXFAST_BACKEND_URL", None)
    frontend_process = ManagedProcess(
        "Next.js",
        production_frontend_command(frontend, config.host, config.port),
        cwd=frontend,
        environment=frontend_environment,
    )

    return ProductionSupervisor(
        config,
        backend,
        frontend_process,
        backend_ready=_readiness_log(
            "FastAPI ready",
            http_readiness_probe(f"{backend_url}/_fluxfast/readyz"),
        ),
        frontend_ready=_readiness_log(
            "Next.js ready",
            tcp_readiness_probe(frontend_connection_host, config.port),
            final_message="application ready",
        ),
    )


def run_production(config: ProductionConfig) -> int:
    """Run one validated production application until shutdown or child failure."""

    supervisor = create_production_supervisor(config)
    print("[fluxfast] production runtime starting", flush=True)
    print(
        f"[fluxfast] FastAPI: {config.backend_host}:{config.backend_port}",
        flush=True,
    )
    print(f"[fluxfast] FastAPI workers: {config.workers}", flush=True)
    print(
        f"[fluxfast] public application: {config.host}:{config.port}",
        flush=True,
    )
    return supervisor.run()


def _validate_frontend(frontend: Path) -> None:
    if not (frontend / "package.json").is_file():
        raise ProductionValidationError(
            f"No package.json found in frontend directory {frontend}"
        )
    if not (frontend / ".next" / "BUILD_ID").is_file():
        raise ProductionBuildMissingError(
            f"No Next.js production build found in {frontend}. Run: fluxfast build"
        )


def _connection_host(host: str) -> str:
    normalized = host.strip().casefold()
    if normalized == "0.0.0.0":
        return "127.0.0.1"
    if normalized in {"::", "[::]"}:
        return "::1"
    return host


def _http_url(host: str, port: int) -> str:
    formatted_host = f"[{host}]" if ":" in host and not host.startswith("[") else host
    return f"http://{formatted_host}:{port}"


def _readiness_log(
    message: str,
    probe: ReadinessProbe,
    *,
    final_message: str | None = None,
) -> ReadinessProbe:
    emitted = False

    def ready() -> bool:
        nonlocal emitted
        result = probe()
        if result and not emitted:
            print(f"[fluxfast] {message}", flush=True)
            if final_message is not None:
                print(f"[fluxfast] {final_message}", flush=True)
            emitted = True
        return result

    return ready
