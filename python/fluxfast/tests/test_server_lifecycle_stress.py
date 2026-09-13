"""Final server lifecycle gate, including descendants of crashed parents."""

from __future__ import annotations

import gc
import json
import os
import signal
import socket
import subprocess
import sys
import time
from contextlib import suppress
from pathlib import Path

import pytest

from fluxfast._process_lifecycle import _stopped_trees
from fluxfast.cli import _stop_process
from fluxfast.production import (
    ManagedProcess,
    ProductionChildError,
    ProductionConfig,
    ProductionStartupError,
    ProductionSupervisor,
    SupervisorState,
    http_readiness_probe,
)

pytestmark = pytest.mark.skipif(os.name != "posix", reason="POSIX process groups")
FIXTURE = Path(__file__).parent / "fixtures" / "lifecycle_process.py"


def _wait_until(predicate, timeout: float = 5) -> None:
    deadline = time.monotonic() + timeout
    while not predicate():
        if time.monotonic() >= deadline:
            pytest.fail("lifecycle condition did not settle before timeout")
        time.sleep(0.01)


def _alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    # PID 1 owns reaping adopted grandchildren; they must not remain running.
    if sys.platform == "linux":
        try:
            stat = Path(f"/proc/{pid}/stat").read_text()
        except FileNotFoundError:
            return False
        return stat.rsplit(")", 1)[1].split()[0] != "Z"
    return True


def _child(name: str, marker: Path, *extra: str) -> ManagedProcess:
    return ManagedProcess(
        name, [sys.executable, str(FIXTURE), "--marker", str(marker), *extra]
    )


def _cleanup(*children: ManagedProcess) -> None:
    for child in children:
        if child.process is None:
            continue
        try:
            os.killpg(child.process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        child.wait(timeout=5)


@pytest.mark.parametrize("failed_child", ["backend", "frontend"])
def test_crashed_parent_does_not_leave_its_descendant_running(
    failed_child: str,
    tmp_path: Path,
) -> None:
    backend_marker = tmp_path / "backend.json"
    frontend_marker = tmp_path / "frontend.json"
    crashing = ("--descendant", "--exit-code", "23")
    backend = _child(
        "FastAPI", backend_marker, *(crashing if failed_child == "backend" else ())
    )
    frontend = _child(
        "Next.js", frontend_marker, *(crashing if failed_child == "frontend" else ())
    )
    supervisor = ProductionSupervisor(
        ProductionConfig(app="backend:app", frontend=tmp_path, shutdown_timeout=0.1),
        backend,
        frontend,
        backend_ready=lambda: True,
        frontend_ready=lambda: True,
        poll_interval=0.01,
    )
    marker = backend_marker if failed_child == "backend" else frontend_marker
    try:
        supervisor.start()
        _wait_until(marker.is_file)
        descendant = json.loads(marker.read_text())["descendant"]
        with pytest.raises(ProductionChildError):
            supervisor.monitor()
        assert supervisor.state == SupervisorState.FAILED
        assert backend.poll() is not None and frontend.poll() is not None
        _wait_until(lambda: not _alive(descendant), timeout=1)
    finally:
        _cleanup(frontend, backend)


@pytest.mark.parametrize("parent_exits", [False, True])
def test_shutdown_timeout_kills_descendant_even_after_parent_exits(
    parent_exits: bool,
    tmp_path: Path,
) -> None:
    marker = tmp_path / "backend.json"
    backend = _child(
        "FastAPI", marker, "--descendant", *(() if parent_exits else ("--ignore-term",))
    )
    frontend = _child("Next.js", tmp_path / "frontend.json")
    supervisor = ProductionSupervisor(
        ProductionConfig(app="backend:app", frontend=tmp_path, shutdown_timeout=0.1),
        backend,
        frontend,
        backend_ready=lambda: True,
        frontend_ready=lambda: True,
        poll_interval=0.01,
    )
    try:
        supervisor.start()
        _wait_until(marker.is_file)
        descendant = json.loads(marker.read_text())["descendant"]
        supervisor.shutdown()
        supervisor.shutdown()
        assert supervisor.state == SupervisorState.STOPPED
        assert backend.poll() is not None and frontend.poll() is not None
        _wait_until(lambda: not _alive(descendant), timeout=1)
    finally:
        _cleanup(frontend, backend)


@pytest.mark.parametrize("parent_exits", [False, True])
def test_development_cleanup_releases_exited_parent_descendants(
    parent_exits: bool,
    tmp_path: Path,
) -> None:
    marker = tmp_path / "dev.json"
    child = _child(
        "dev", marker, "--descendant", *(("--exit-code", "7") if parent_exits else ())
    )
    try:
        process = child.start()
        _wait_until(marker.is_file)
        descendant = json.loads(marker.read_text())["descendant"]
        if parent_exits:
            assert child.wait(timeout=5) == 7
        _stop_process(process)
        assert process.poll() is not None
        _wait_until(lambda: not _alive(descendant), timeout=1)
    finally:
        _cleanup(child)


@pytest.mark.parametrize("timed_out_child", ["backend", "frontend"])
def test_real_startup_timeout_stops_all_started_process_trees(
    timed_out_child, tmp_path
) -> None:
    backend_marker = tmp_path / "backend.json"
    frontend_marker = tmp_path / "frontend.json"
    backend = _child("FastAPI", backend_marker, "--descendant")
    frontend = _child("Next.js", frontend_marker, "--descendant")
    supervisor = ProductionSupervisor(
        ProductionConfig(
            app="backend:app",
            frontend=tmp_path,
            startup_timeout=0.5,
            shutdown_timeout=0.1,
        ),
        backend,
        frontend,
        backend_ready=lambda: timed_out_child != "backend" and backend_marker.is_file(),
        frontend_ready=lambda: False,
        poll_interval=0.01,
    )
    try:
        with pytest.raises(ProductionStartupError, match="did not become ready"):
            supervisor.start()
        assert supervisor.state == SupervisorState.FAILED
        assert backend.poll() is not None
        assert (frontend.process is None) == (timed_out_child == "backend")
        if frontend.process is not None:
            assert frontend.poll() is not None
        for marker in [backend_marker, frontend_marker]:
            if marker.is_file():
                descendant = json.loads(marker.read_text())["descendant"]
                _wait_until(lambda descendant=descendant: not _alive(descendant))
    finally:
        _cleanup(frontend, backend)


@pytest.mark.parametrize("mode", ["dev", "production"])
@pytest.mark.parametrize("signum", [signal.SIGTERM, signal.SIGINT])
def test_repeated_real_supervisor_signals_restore_handlers_and_reap_children(
    mode, signum, tmp_path
) -> None:
    harness = FIXTURE.with_name("lifecycle_supervisor.py")
    for cycle in range(4):
        directory = tmp_path / str(cycle)
        directory.mkdir()
        (directory / "package.json").write_text('{"scripts":{"dev":"test-only"}}')
        process = subprocess.Popen(
            [
                sys.executable,
                str(harness),
                "--mode",
                mode,
                "--directory",
                str(directory),
            ],
            start_new_session=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        child_pids: list[int] = []
        try:
            _wait_until(
                lambda directory=directory, process=process: (
                    (directory / "frontend.json").is_file()
                    or process.poll() is not None
                )
            )
            assert process.poll() is None
            child_pids = [
                json.loads((directory / f"{name}.json").read_text())["pid"]
                for name in ["backend", "frontend"]
            ]
            process.send_signal(signum)
            output, errors = process.communicate(timeout=10)
            assert process.returncode == 0, (output, errors)
            result = json.loads((directory / "result.json").read_text())
            assert result == {"status": 0, "handlers_restored": True}
            for pid in child_pids:
                _wait_until(lambda pid=pid: not _alive(pid))
        finally:
            for pid in child_pids:
                if _alive(pid):
                    with suppress(ProcessLookupError):
                        os.killpg(pid, signal.SIGKILL)
            if process.poll() is None:
                process.kill()
            process.communicate(timeout=5)


@pytest.mark.parametrize("mode", ["dev", "production"])
def test_real_supervisor_startup_timeout_restores_signal_handlers(
    mode, tmp_path
) -> None:
    (tmp_path / "package.json").write_text('{"scripts":{"dev":"test-only"}}')
    result = subprocess.run(
        [
            sys.executable,
            str(FIXTURE.with_name("lifecycle_supervisor.py")),
            "--mode",
            mode,
            "--directory",
            str(tmp_path),
            "--startup-timeout",
        ],
        capture_output=True,
        timeout=10,
        check=False,
    )
    assert result.returncode != 0
    assert json.loads((tmp_path / "result.json").read_text())["handlers_restored"]
    assert not (tmp_path / "frontend.json").exists()
    if (tmp_path / "backend.json").is_file():
        pid = json.loads((tmp_path / "backend.json").read_text())["pid"]
        _wait_until(lambda: not _alive(pid))


@pytest.mark.parametrize("signum", [signal.SIGTERM, signal.SIGINT])
def test_real_uvicorn_workers_close_application_broker_and_cache(
    signum, tmp_path
) -> None:
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
    environment = os.environ.copy()
    environment["FLUXFAST_TEST_LIFECYCLE_DIRECTORY"] = str(tmp_path)
    backend = ManagedProcess(
        "FastAPI workers",
        [
            sys.executable,
            "-m",
            "uvicorn",
            "lifecycle_worker:app",
            "--workers",
            "2",
            "--host",
            "127.0.0.1",
            "--port",
            str(port),
            "--log-level",
            "warning",
        ],
        cwd=FIXTURE.parent,
        environment=environment,
    )
    frontend = _child("Next.js", tmp_path / "frontend.json")
    supervisor = ProductionSupervisor(
        ProductionConfig(
            app="lifecycle_worker:app",
            frontend=tmp_path,
            startup_timeout=15,
            shutdown_timeout=3,
        ),
        backend,
        frontend,
        backend_ready=http_readiness_probe(f"http://127.0.0.1:{port}/_fluxfast/readyz"),
        frontend_ready=lambda: (tmp_path / "frontend.json").is_file(),
        poll_interval=0.01,
    )
    try:
        supervisor.start()
        _wait_until(lambda: len(list(tmp_path.glob("*-startup.json"))) == 2)
        worker_pids = [
            json.loads(marker.read_text())["pid"]
            for marker in tmp_path.glob("*-startup.json")
        ]
        assert len(set(worker_pids)) == 2
        assert backend.process is not None
        backend.process.send_signal(signum)
        backend.wait(timeout=10)
        with pytest.raises(ProductionChildError):
            supervisor.monitor()
        assert frontend.poll() is not None
        for pid in worker_pids:
            for phase in ["application-shutdown", "broker-close", "cache-close"]:
                assert (tmp_path / f"{pid}-{phase}.json").is_file()
            _wait_until(lambda pid=pid: not _alive(pid))
    finally:
        _cleanup(frontend, backend)


def test_100_real_process_teardowns_do_not_retain_process_owners() -> None:
    gc.collect()
    baseline = len(_stopped_trees)
    for _ in range(100):
        child = ManagedProcess("short-lived", [sys.executable, "-c", "pass"])
        child.start()
        try:
            child.wait(timeout=5)
            child._stop_tree(0.01)
            child._stop_tree(0.01)
            assert child.poll() == 0
        finally:
            _cleanup(child)
        del child
    gc.collect()
    assert len(_stopped_trees) <= baseline


@pytest.mark.skipif(sys.platform != "linux", reason="Linux isolated subreaper")
def test_pid1_equivalent_shutdown_reaps_adopted_descendants(tmp_path) -> None:
    process = subprocess.Popen(
        [
            sys.executable,
            str(FIXTURE.with_name("lifecycle_supervisor.py")),
            "--mode",
            "production",
            "--directory",
            str(tmp_path),
            "--subreaper",
        ],
        start_new_session=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    try:
        _wait_until(
            lambda: (tmp_path / "frontend.json").is_file() or process.poll() is not None
        )
        assert process.poll() is None
        process.send_signal(signal.SIGTERM)
        output, errors = process.communicate(timeout=10)
        assert process.returncode == 0, (output, errors)
        assert json.loads((tmp_path / "result.json").read_text())[
            "adopted_descendants_reaped"
        ]
    finally:
        if process.poll() is None:
            process.kill()
        process.communicate(timeout=5)


@pytest.mark.parametrize("mode", ["dev", "production"])
def test_second_signal_cannot_interrupt_in_progress_sibling_cleanup(
    mode, tmp_path
) -> None:
    (tmp_path / "package.json").write_text('{"scripts":{"dev":"test-only"}}')
    process = subprocess.Popen(
        [
            sys.executable,
            str(FIXTURE.with_name("lifecycle_supervisor.py")),
            "--mode",
            mode,
            "--directory",
            str(tmp_path),
            "--ignore-frontend-term",
        ],
        start_new_session=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    child_pids = []
    try:
        _wait_until(
            lambda: (tmp_path / "frontend.json").is_file() or process.poll() is not None
        )
        assert process.poll() is None
        child_pids = [
            json.loads((tmp_path / f"{name}.json").read_text())["pid"]
            for name in ["backend", "frontend"]
        ]
        process.send_signal(signal.SIGTERM)
        time.sleep(0.05)
        assert process.poll() is None
        process.send_signal(signal.SIGINT)
        output, errors = process.communicate(timeout=10)
        assert process.returncode == 0, (output, errors)
        assert json.loads((tmp_path / "result.json").read_text())["handlers_restored"]
        for pid in child_pids:
            _wait_until(lambda pid=pid: not _alive(pid))
    finally:
        for pid in child_pids:
            if _alive(pid):
                with suppress(ProcessLookupError):
                    os.killpg(pid, signal.SIGKILL)
        if process.poll() is None:
            process.kill()
        process.communicate(timeout=5)
