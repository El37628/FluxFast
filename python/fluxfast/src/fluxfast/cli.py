"""Command-line development tools for FluxFast applications."""

from __future__ import annotations

import argparse
import importlib
import os
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from types import FrameType

from fastapi import FastAPI

from . import __version__
from .production import (
    ManagedProcessError,
    ProductionBuildError,
    ProductionBuildMissingError,
    ProductionChildError,
    ProductionConfigError,
    ProductionStartupError,
    ProductionValidationError,
    check_frontend_command,
    resolve_build_frontend,
    resolve_production_config,
    run_frontend_build,
    run_production,
)
from .production.frontend import detect_package_manager
from .schema_export import build_app_schema_manifest
from .serialization import canonical_json


@dataclass(frozen=True)
class DevConfig:
    """Configuration for the local FastAPI and frontend supervisor."""

    app: str
    frontend: Path
    backend_host: str = "127.0.0.1"
    backend_port: int | None = None
    frontend_host: str = "127.0.0.1"
    frontend_port: int = 3000
    reload: bool = True
    startup_timeout: float = 15.0


class DevServerError(RuntimeError):
    """Raised when the local development processes cannot be started."""


class SchemaCommandError(RuntimeError):
    """Raised when an application schema cannot be loaded or exported."""


class TypeGenerationError(RuntimeError):
    """Raised when full-stack type generation cannot be started."""


def _frontend_package_manager(frontend: Path) -> str:
    return detect_package_manager(frontend)


def _available_port(host: str) -> int:
    family = socket.AF_INET6 if ":" in host else socket.AF_INET
    with socket.socket(family, socket.SOCK_STREAM) as sock:
        sock.bind((host, 0))
        return int(sock.getsockname()[1])


def _frontend_command(frontend: Path, host: str, port: int) -> list[str]:
    manager = _frontend_package_manager(frontend)
    if shutil.which(manager) is None:
        raise DevServerError(
            f"Could not find '{manager}' on PATH for frontend directory {frontend}"
        )
    separator = ["--"] if manager == "npm" else []
    return [
        manager,
        "run",
        "dev",
        *separator,
        "--hostname",
        host,
        "--port",
        str(port),
    ]


def _type_generation_command(
    frontend: Path,
    schema_file: Path,
    *,
    check: bool,
) -> list[str]:
    manager = _frontend_package_manager(frontend)
    if shutil.which(manager) is None:
        raise TypeGenerationError(
            f"Could not find '{manager}' on PATH for frontend directory {frontend}"
        )
    prefix = {
        "npm": ["npm", "exec", "--no", "--"],
        "pnpm": ["pnpm", "exec"],
        "yarn": ["yarn", "exec"],
        "bun": ["bun", "x", "--no-install"],
    }[manager]
    command = [
        *prefix,
        "fluxfast",
        "generate",
        "--schema-file",
        str(schema_file),
    ]
    if check:
        command.append("--check")
    return command


def _process_kwargs() -> dict[str, object]:
    if os.name == "posix":
        return {"start_new_session": True}
    creation_flags = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
    return {"creationflags": creation_flags}


def _stop_process(process: subprocess.Popen[bytes] | None) -> None:
    if process is None or process.poll() is not None:
        return
    if os.name == "posix":
        os.killpg(process.pid, signal.SIGTERM)
    else:
        process.terminate()
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        if os.name == "posix":
            os.killpg(process.pid, signal.SIGKILL)
        else:
            process.kill()
        process.wait(timeout=5)


def _wait_for_backend(
    process: subprocess.Popen[bytes],
    host: str,
    port: int,
    timeout: float,
) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        return_code = process.poll()
        if return_code is not None:
            raise DevServerError(
                f"FastAPI process exited before startup (status {return_code})"
            )
        try:
            with socket.create_connection((host, port), timeout=0.2):
                return
        except OSError:
            time.sleep(0.05)
    raise DevServerError(
        f"FastAPI did not listen on {host}:{port} within {timeout:g} seconds"
    )


def run_dev(config: DevConfig) -> int:
    """Run FastAPI and the frontend as one supervised development command."""

    frontend = config.frontend.resolve()
    if not (frontend / "package.json").is_file():
        raise DevServerError(f"No package.json found in frontend directory {frontend}")

    backend_port = config.backend_port or _available_port(config.backend_host)
    backend_url = f"http://{config.backend_host}:{backend_port}"
    backend_command = [
        sys.executable,
        "-m",
        "uvicorn",
        config.app,
        "--host",
        config.backend_host,
        "--port",
        str(backend_port),
    ]
    if config.reload:
        backend_command.append("--reload")
    frontend_command = _frontend_command(
        frontend,
        config.frontend_host,
        config.frontend_port,
    )
    frontend_environment = os.environ.copy()
    frontend_environment["FLUXFAST_BACKEND_URL"] = backend_url
    frontend_environment.pop("NEXT_PUBLIC_FLUXFAST_BACKEND_URL", None)

    print(f"[fluxfast] FastAPI internal URL: {backend_url}", flush=True)
    print(
        f"[fluxfast] Application URL: http://{config.frontend_host}:{config.frontend_port}",
        flush=True,
    )

    backend_process: subprocess.Popen[bytes] | None = None
    frontend_process: subprocess.Popen[bytes] | None = None
    previous_sigterm = signal.getsignal(signal.SIGTERM)

    def request_shutdown(_signum: int, _frame: FrameType | None) -> None:
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, request_shutdown)
    try:
        backend_process = subprocess.Popen(backend_command, **_process_kwargs())
        _wait_for_backend(
            backend_process,
            config.backend_host,
            backend_port,
            config.startup_timeout,
        )
        frontend_process = subprocess.Popen(
            frontend_command,
            cwd=frontend,
            env=frontend_environment,
            **_process_kwargs(),
        )

        while True:
            backend_status = backend_process.poll()
            frontend_status = frontend_process.poll()
            if backend_status is not None:
                return backend_status or 1
            if frontend_status is not None:
                return frontend_status or 1
            time.sleep(0.1)
    except KeyboardInterrupt:
        return 0
    finally:
        _stop_process(frontend_process)
        _stop_process(backend_process)
        signal.signal(signal.SIGTERM, previous_sigterm)


def _load_schema_app(app_import: str) -> FastAPI:
    """Import and resolve a FastAPI application from ``module:attribute``."""

    module_name, separator, attribute_path = app_import.partition(":")
    if not separator or not module_name or not attribute_path:
        raise SchemaCommandError(
            "Application import must use module:attribute format, for example backend:app"
        )

    try:
        value: object = importlib.import_module(module_name)
    except Exception as error:
        raise SchemaCommandError(
            f"Could not import application module '{module_name}': {error}"
        ) from error

    try:
        for attribute in attribute_path.split("."):
            value = getattr(value, attribute)
    except AttributeError as error:
        raise SchemaCommandError(
            f"Application import '{app_import}' does not resolve to an attribute"
        ) from error

    if not isinstance(value, FastAPI):
        raise SchemaCommandError(
            f"Application import '{app_import}' must resolve to a FastAPI application"
        )
    return value


def _schema_manifest_text(app: FastAPI) -> str:
    """Build stable JSON bytes for one application's developer schema manifest."""

    try:
        manifest = build_app_schema_manifest(app, producer=__version__)
    except TypeError as error:
        raise SchemaCommandError(str(error)) from error
    payload = manifest.model_dump(mode="json", by_alias=True, exclude_none=True)
    return f"{canonical_json(payload)}\n"


def run_schema(
    app_import: str,
    *,
    output: Path | None = None,
    check: bool = False,
) -> int:
    """Export or verify the deterministic developer schema manifest."""

    app = _load_schema_app(app_import)
    manifest_text = _schema_manifest_text(app)
    manifest_bytes = manifest_text.encode("utf-8")

    if check:
        if output is None:
            raise SchemaCommandError("--check requires --output")
        if not output.is_file():
            print(f"[fluxfast] schema manifest is missing: {output}", file=sys.stderr)
            return 1
        if output.read_bytes() != manifest_bytes:
            print(f"[fluxfast] schema manifest is stale: {output}", file=sys.stderr)
            return 1
        return 0

    if output is None:
        sys.stdout.write(manifest_text)
        return 0

    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(manifest_bytes)
    return 0


def run_types(
    app_import: str,
    *,
    frontend: Path,
    check: bool = False,
) -> int:
    """Export the backend schema and compose it with frontend generation."""

    frontend = frontend.resolve()
    if not (frontend / "package.json").is_file():
        raise TypeGenerationError(
            f"No package.json found in frontend directory {frontend}"
        )

    app = _load_schema_app(app_import)
    manifest_text = _schema_manifest_text(app)
    with tempfile.TemporaryDirectory(prefix="fluxfast-types-") as directory:
        schema_file = Path(directory) / "schema.generated.json"
        schema_file.write_text(manifest_text, encoding="utf8")
        command = _type_generation_command(frontend, schema_file, check=check)
        result = subprocess.run(command, cwd=frontend, check=False)
    return int(result.returncode)


def run_build(
    *,
    frontend: Path | None = None,
    app_import: str | None = None,
) -> int:
    """Validate generated artifacts and run the existing production build."""

    resolved_frontend = resolve_build_frontend(frontend)
    print(f"[fluxfast] validating frontend: {resolved_frontend}", flush=True)
    check_frontend_command(resolved_frontend, "init")
    if app_import is None:
        check_frontend_command(resolved_frontend, "generate")
    else:
        status = run_types(app_import, frontend=resolved_frontend, check=True)
        if status != 0:
            raise ProductionBuildError(
                f"Backend contract validation failed with status {status}"
            )
    print("[fluxfast] building production frontend", flush=True)
    return run_frontend_build(resolved_frontend)


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="fluxfast")
    subparsers = parser.add_subparsers(dest="command", required=True)
    dev = subparsers.add_parser(
        "dev",
        help="run FastAPI and the frontend with one public browser origin",
    )
    dev.add_argument("app", help="ASGI application import, for example backend.app.main:app")
    dev.add_argument("--frontend", type=Path, default=Path.cwd())
    dev.add_argument("--backend-host", default="127.0.0.1")
    dev.add_argument("--backend-port", type=int)
    dev.add_argument("--frontend-host", default="127.0.0.1")
    dev.add_argument("--frontend-port", type=int, default=3000)
    dev.add_argument("--no-reload", action="store_true")
    dev.add_argument("--startup-timeout", type=float, default=15.0)

    build = subparsers.add_parser(
        "build",
        help="validate generated artifacts and build the production frontend",
    )
    build.add_argument("--frontend", type=Path)
    build.add_argument(
        "--app",
        help="optionally verify this FastAPI application contract before building",
    )

    start = subparsers.add_parser(
        "start",
        help="run FastAPI and Next.js as one supervised production service",
    )
    start.add_argument(
        "app",
        help="ASGI application import, for example backend.main:app",
    )
    start.add_argument("--frontend", type=Path, default=Path.cwd())
    start.add_argument("--host")
    start.add_argument("--port", type=int)
    start.add_argument("--backend-host")
    start.add_argument("--backend-port", type=int)
    start.add_argument("--workers", type=int)
    start.add_argument("--startup-timeout", type=float)
    start.add_argument("--shutdown-timeout", type=float)

    schema = subparsers.add_parser(
        "schema",
        help="export the offline FluxFast schema manifest",
    )
    schema.add_argument(
        "app",
        help="FastAPI application import, for example backend:app",
    )
    schema.add_argument(
        "--output",
        type=Path,
        help="write the manifest to this path instead of stdout",
    )
    schema.add_argument(
        "--check",
        action="store_true",
        help="exit non-zero when the output manifest is missing or stale",
    )

    types = subparsers.add_parser(
        "types",
        help="export the backend schema and generate frontend TypeScript",
    )
    types.add_argument(
        "app",
        help="FastAPI application import, for example backend:app",
    )
    types.add_argument("--frontend", type=Path, default=Path.cwd())
    types.add_argument(
        "--check",
        action="store_true",
        help="check the schema and generated frontend files without writing",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    """FluxFast command-line entry point."""

    args = _parser().parse_args(argv)
    if args.command == "dev":
        try:
            return run_dev(
                DevConfig(
                    app=args.app,
                    frontend=args.frontend,
                    backend_host=args.backend_host,
                    backend_port=args.backend_port,
                    frontend_host=args.frontend_host,
                    frontend_port=args.frontend_port,
                    reload=not args.no_reload,
                    startup_timeout=args.startup_timeout,
                )
            )
        except DevServerError as error:
            print(f"[fluxfast] {error}", file=sys.stderr)
            return 1
    if args.command == "build":
        try:
            return run_build(frontend=args.frontend, app_import=args.app)
        except (
            ProductionBuildError,
            ProductionValidationError,
            SchemaCommandError,
            TypeGenerationError,
            OSError,
        ) as error:
            print(f"[fluxfast] {error}", file=sys.stderr)
            return 3
    if args.command == "start":
        try:
            config = resolve_production_config(
                args.app,
                args.frontend,
                host=args.host,
                port=args.port,
                backend_host=args.backend_host,
                backend_port=args.backend_port,
                workers=args.workers,
                startup_timeout=args.startup_timeout,
                shutdown_timeout=args.shutdown_timeout,
            )
            return run_production(config)
        except ProductionConfigError as error:
            print(f"[fluxfast] {error}", file=sys.stderr)
            return 2
        except ProductionBuildMissingError as error:
            print(f"[fluxfast] {error}", file=sys.stderr)
            return 5
        except ProductionStartupError as error:
            print(f"[fluxfast] {error}", file=sys.stderr)
            return 4
        except ProductionChildError as error:
            print(f"[fluxfast] {error}", file=sys.stderr)
            return 1
        except (ProductionValidationError, ManagedProcessError, OSError) as error:
            print(f"[fluxfast] {error}", file=sys.stderr)
            return 3
    if args.command == "schema":
        try:
            return run_schema(
                args.app,
                output=args.output,
                check=args.check,
            )
        except (SchemaCommandError, OSError) as error:
            print(f"[fluxfast] {error}", file=sys.stderr)
            return 1
    if args.command == "types":
        try:
            return run_types(
                args.app,
                frontend=args.frontend,
                check=args.check,
            )
        except (SchemaCommandError, TypeGenerationError, OSError) as error:
            print(f"[fluxfast] {error}", file=sys.stderr)
            return 1
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
