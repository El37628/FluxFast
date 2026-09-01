"""Tests for managed production child-process lifecycle."""

import os
import signal
import sys
from pathlib import Path
from subprocess import TimeoutExpired

import pytest

from fluxfast.production.process import ManagedProcess, ManagedProcessError


class FakeProcess:
    def __init__(self, command: list[str], **kwargs: object) -> None:
        self.command = command
        self.kwargs = kwargs
        self.pid = 4312
        self.return_code: int | None = None
        self.wait_calls: list[float | None] = []
        self.terminate_calls = 0
        self.kill_calls = 0

    def poll(self) -> int | None:
        return self.return_code

    def wait(self, timeout: float | None = None) -> int:
        self.wait_calls.append(timeout)
        if timeout == 0:
            raise TimeoutExpired(self.command, timeout)
        return 0 if self.return_code is None else self.return_code

    def terminate(self) -> None:
        self.terminate_calls += 1

    def kill(self) -> None:
        self.kill_calls += 1


def test_managed_process_propagates_real_child_exit_code() -> None:
    managed = ManagedProcess(
        "exiting child",
        [sys.executable, "-c", "raise SystemExit(7)"],
    )

    managed.start()

    assert managed.wait(timeout=5) == 7
    assert managed.poll() == 7


@pytest.mark.skipif(os.name != "posix", reason="POSIX process-group semantics")
@pytest.mark.parametrize(
    ("operation", "expected_signal"),
    [("terminate", signal.SIGTERM), ("kill", signal.SIGKILL)],
)
def test_managed_process_stops_a_real_child_process_group(
    operation: str,
    expected_signal: signal.Signals,
) -> None:
    managed = ManagedProcess(
        "sleeping child",
        [sys.executable, "-c", "import time; time.sleep(60)"],
    )
    managed.start()

    try:
        getattr(managed, operation)()
        assert managed.wait(timeout=5) == -expected_signal
    finally:
        if managed.poll() is None:
            managed.kill()
            managed.wait(timeout=5)


def test_managed_process_starts_once_without_shell_or_output_capture(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    created: list[FakeProcess] = []

    def popen(command: list[str], **kwargs: object) -> FakeProcess:
        process = FakeProcess(command, **kwargs)
        created.append(process)
        return process

    monkeypatch.setattr("fluxfast.production.process.subprocess.Popen", popen)
    environment = {"NODE_ENV": "production"}
    managed = ManagedProcess(
        "Next.js",
        ["npm", "run", "start"],
        cwd=tmp_path,
        environment=environment,
    )
    environment["NODE_ENV"] = "development"

    process = managed.start()

    assert process is created[0]
    assert process.command == ["npm", "run", "start"]
    assert process.kwargs["cwd"] == tmp_path
    assert process.kwargs["env"] == {"NODE_ENV": "production"}
    assert process.kwargs["shell"] is False
    assert process.kwargs["start_new_session"] is True
    assert "stdout" not in process.kwargs
    assert "stderr" not in process.kwargs

    with pytest.raises(ManagedProcessError, match="already been started"):
        managed.start()


def test_managed_process_reports_poll_and_wait_exit_codes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    process = FakeProcess(["server"])
    monkeypatch.setattr(
        "fluxfast.production.process.subprocess.Popen",
        lambda *_args, **_kwargs: process,
    )
    managed = ManagedProcess("FastAPI", ["server"])

    managed.start()
    assert managed.poll() is None
    process.return_code = 7
    assert managed.poll() == 7
    assert managed.wait(timeout=2.5) == 7
    assert process.wait_calls == [2.5]


def test_managed_process_preserves_wait_timeout(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    process = FakeProcess(["server"])
    monkeypatch.setattr(
        "fluxfast.production.process.subprocess.Popen",
        lambda *_args, **_kwargs: process,
    )
    managed = ManagedProcess("FastAPI", ["server"])
    managed.start()

    with pytest.raises(TimeoutExpired):
        managed.wait(timeout=0)


def test_managed_process_terminates_and_kills_the_posix_process_group(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    process = FakeProcess(["server"])
    signals: list[tuple[int, object]] = []
    monkeypatch.setattr(
        "fluxfast.production.process.subprocess.Popen",
        lambda *_args, **_kwargs: process,
    )
    monkeypatch.setattr(
        "fluxfast.production.process.os.killpg",
        lambda pid, signum: signals.append((pid, signum)),
    )
    managed = ManagedProcess("FastAPI", ["server"])
    managed.start()

    managed.terminate()
    managed.kill()

    assert signals == [(process.pid, 15), (process.pid, 9)]


def test_managed_process_does_not_signal_an_exited_child(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    process = FakeProcess(["server"])
    process.return_code = 0
    monkeypatch.setattr(
        "fluxfast.production.process.subprocess.Popen",
        lambda *_args, **_kwargs: process,
    )
    monkeypatch.setattr(
        "fluxfast.production.process.os.killpg",
        lambda *_args: pytest.fail("exited child must not be signalled"),
    )
    managed = ManagedProcess("FastAPI", ["server"])
    managed.start()

    managed.terminate()
    managed.kill()


def test_managed_process_tolerates_exit_during_signal_delivery(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    process = FakeProcess(["server"])
    monkeypatch.setattr(
        "fluxfast.production.process.subprocess.Popen",
        lambda *_args, **_kwargs: process,
    )

    def missing_process(_pid: int, _signum: object) -> None:
        raise ProcessLookupError

    monkeypatch.setattr("fluxfast.production.process.os.killpg", missing_process)
    managed = ManagedProcess("FastAPI", ["server"])
    managed.start()

    managed.terminate()


@pytest.mark.parametrize(
    ("name", "command", "message"),
    [
        ("", ["server"], "name must not be empty"),
        ("server", [], "command must not be empty"),
        ("server", ["server", ""], "arguments must be non-empty strings"),
    ],
)
def test_managed_process_rejects_invalid_identity_and_command(
    name: str,
    command: list[str],
    message: str,
) -> None:
    with pytest.raises(ManagedProcessError, match=message):
        ManagedProcess(name, command)


def test_managed_process_requires_start_before_lifecycle_operations() -> None:
    managed = ManagedProcess("FastAPI", ["server"])

    with pytest.raises(ManagedProcessError, match="has not been started"):
        managed.poll()
    with pytest.raises(ManagedProcessError, match="has not been started"):
        managed.wait()
    with pytest.raises(ManagedProcessError, match="has not been started"):
        managed.terminate()
    with pytest.raises(ManagedProcessError, match="has not been started"):
        managed.kill()
