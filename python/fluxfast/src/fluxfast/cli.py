"""Command-line development tools for FluxFast applications."""

from __future__ import annotations

import argparse
import importlib
import json
import os
import shutil
import signal
import socket
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from types import FrameType

from fastapi import FastAPI

from . import __version__
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


def _available_port(host: str) -> int:
    family = socket.AF_INET6 if ":" in host else socket.AF_INET
    with socket.socket(family, socket.SOCK_STREAM) as sock:
        sock.bind((host, 0))
        return int(sock.getsockname()[1])


def _frontend_command(frontend: Path, host: str, port: int) -> list[str]:
    candidates = (
        ("pnpm-lock.yaml", "pnpm"),
        ("yarn.lock", "yarn"),
        ("bun.lock", "bun"),
        ("bun.lockb", "bun"),
        ("package-lock.json", "npm"),
    )
    manager = next((name for lock, name in candidates if (frontend / lock).exists()), None)
    if manager is None:
        try:
            manifest = json.loads((frontend / "package.json").read_text(encoding="utf8"))
        except (OSError, json.JSONDecodeError):
            manifest = {}
        declared_manager = manifest.get("packageManager")
        if isinstance(declared_manager, str):
            candidate = declared_manager.split("@", 1)[0]
            if candidate in {name for _lock, name in candidates}:
                manager = candidate
    manager = manager or "npm"
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
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
