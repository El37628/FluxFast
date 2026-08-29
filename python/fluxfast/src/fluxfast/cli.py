"""Command-line development tools for FluxFast applications."""

from __future__ import annotations

import argparse
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
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
