"""Adversarial real-process tests for production sibling failure handling."""

import os
import signal
import sys
from pathlib import Path

import pytest

from fluxfast.production import (
    ManagedProcess,
    ProductionChildError,
    ProductionConfig,
    ProductionSupervisor,
    SupervisorState,
)

pytestmark = pytest.mark.skipif(
    os.name != "posix",
    reason="production process-group assertions require POSIX",
)


def _sleeping_process(name: str) -> ManagedProcess:
    return ManagedProcess(
        name,
        [sys.executable, "-c", "import time; time.sleep(60)"],
    )


def _exiting_process(name: str, return_code: int) -> ManagedProcess:
    return ManagedProcess(
        name,
        [
            sys.executable,
            "-c",
            f"import time; time.sleep(0.3); raise SystemExit({return_code})",
        ],
    )


def _supervisor(
    backend: ManagedProcess,
    frontend: ManagedProcess,
) -> ProductionSupervisor:
    return ProductionSupervisor(
        ProductionConfig(
            app="backend:app",
            frontend=Path("frontend"),
            startup_timeout=2,
            shutdown_timeout=2,
        ),
        backend,
        frontend,
        backend_ready=lambda: True,
        frontend_ready=lambda: True,
        poll_interval=0.01,
    )


def _force_cleanup(*children: ManagedProcess) -> None:
    for child in children:
        if child.process is not None and child.poll() is None:
            child.kill()
            child.wait(timeout=2)


@pytest.mark.parametrize(
    ("failed_child", "return_code"),
    [("backend", 23), ("frontend", 31)],
)
def test_child_crash_stops_and_reaps_its_sibling(
    failed_child: str,
    return_code: int,
) -> None:
    backend = (
        _exiting_process("FastAPI", return_code)
        if failed_child == "backend"
        else _sleeping_process("FastAPI")
    )
    frontend = (
        _exiting_process("Next.js", return_code)
        if failed_child == "frontend"
        else _sleeping_process("Next.js")
    )
    supervisor = _supervisor(backend, frontend)

    try:
        supervisor.start()
        with pytest.raises(ProductionChildError) as raised:
            supervisor.monitor()

        assert raised.value.child_name == (
            "FastAPI" if failed_child == "backend" else "Next.js"
        )
        assert raised.value.return_code == return_code
        assert supervisor.state == SupervisorState.FAILED
        assert backend.poll() is not None
        assert frontend.poll() is not None

        sibling = frontend if failed_child == "backend" else backend
        assert sibling.poll() == -signal.SIGTERM
    finally:
        _force_cleanup(frontend, backend)


def test_unexpected_zero_exit_still_stops_sibling_and_fails_runtime() -> None:
    backend = _sleeping_process("FastAPI")
    frontend = _exiting_process("Next.js", 0)
    supervisor = _supervisor(backend, frontend)

    try:
        supervisor.start()
        with pytest.raises(ProductionChildError) as raised:
            supervisor.monitor()

        assert raised.value.child_name == "Next.js"
        assert raised.value.return_code == 0
        assert supervisor.state == SupervisorState.FAILED
        assert backend.poll() == -signal.SIGTERM
        assert frontend.poll() == 0
    finally:
        _force_cleanup(frontend, backend)
