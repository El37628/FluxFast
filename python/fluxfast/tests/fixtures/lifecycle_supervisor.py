"""Run actual supervisor signal paths in an isolated test subprocess."""

from __future__ import annotations

import argparse
import json
import os
import signal
import socket
import subprocess
import sys
from pathlib import Path

from fluxfast import cli
from fluxfast.production import ManagedProcess, ProductionConfig, ProductionSupervisor

parser = argparse.ArgumentParser()
parser.add_argument("--mode", choices=["dev", "production"], required=True)
parser.add_argument("--directory", type=Path, required=True)
parser.add_argument("--startup-timeout", action="store_true")
parser.add_argument("--subreaper", action="store_true")
parser.add_argument("--ignore-frontend-term", action="store_true")
arguments = parser.parse_args()
if arguments.subreaper:
    import ctypes

    if ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0) != 0:
        raise RuntimeError("could not enable isolated test subreaper")
directory = arguments.directory
fixture = Path(__file__).with_name("lifecycle_process.py")
previous = {
    signum: signal.getsignal(signum) for signum in (signal.SIGTERM, signal.SIGINT)
}


def command(name: str) -> list[str]:
    argv = [sys.executable, str(fixture), "--marker", str(directory / f"{name}.json")]
    if name == "frontend" and arguments.ignore_frontend_term:
        argv += ["--ignore-term"]
    return argv + (["--descendant"] if arguments.subreaper else [])


status = 1
try:
    if arguments.mode == "production":
        supervisor = ProductionSupervisor(
            ProductionConfig(
                app="backend:app",
                frontend=directory,
                startup_timeout=0.15 if arguments.startup_timeout else 5,
                shutdown_timeout=0.15,
            ),
            ManagedProcess("FastAPI", command("backend")),
            ManagedProcess("Next.js", command("frontend")),
            backend_ready=lambda: (
                not arguments.startup_timeout and (directory / "backend.json").is_file()
            ),
            frontend_ready=lambda: (directory / "frontend.json").is_file(),
            poll_interval=0.01,
        )
        status = supervisor.run()
    else:
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            port = listener.getsockname()[1]
        native_popen = subprocess.Popen

        def spawn(argv, **kwargs):
            if argv[1:3] == ["-m", "uvicorn"]:
                argv = command("backend")
                if not arguments.startup_timeout:
                    argv += ["--port", str(port)]
            return native_popen(argv, **kwargs)

        cli.subprocess.Popen = spawn
        cli._frontend_command = lambda *args: command("frontend")
        status = cli.run_dev(
            cli.DevConfig(
                app="backend:app",
                frontend=directory,
                backend_port=port,
                reload=False,
                startup_timeout=0.15 if arguments.startup_timeout else 5,
            )
        )
finally:
    restored = all(
        signal.getsignal(signum) == handler for signum, handler in previous.items()
    )
    result = {"status": status, "handlers_restored": restored}
    if arguments.subreaper:
        gone = True
        for marker in [directory / "backend.json", directory / "frontend.json"]:
            if marker.is_file():
                descendant = json.loads(marker.read_text())["descendant"]
                try:
                    os.kill(descendant, 0)
                except ProcessLookupError:
                    pass
                else:
                    gone = False
        result["adopted_descendants_reaped"] = gone
    (directory / "result.json").write_text(json.dumps(result))
raise SystemExit(status)
