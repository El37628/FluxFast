"""Tests for the one-command development supervisor."""

from pathlib import Path

import pytest

from fluxfast.cli import DevConfig, DevServerError, _frontend_command, run_dev


def test_frontend_command_detects_package_manager(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    (tmp_path / "package-lock.json").touch()
    monkeypatch.setattr("fluxfast.cli.shutil.which", lambda name: f"/bin/{name}")

    assert _frontend_command(tmp_path, "127.0.0.1", 3100) == [
        "npm",
        "run",
        "dev",
        "--",
        "--hostname",
        "127.0.0.1",
        "--port",
        "3100",
    ]


def test_frontend_command_reports_missing_manager(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    (tmp_path / "pnpm-lock.yaml").touch()
    monkeypatch.setattr("fluxfast.cli.shutil.which", lambda _name: None)

    with pytest.raises(DevServerError, match="Could not find 'pnpm'"):
        _frontend_command(tmp_path, "127.0.0.1", 3000)


def test_frontend_command_honors_declared_package_manager_without_local_lock(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    (tmp_path / "package.json").write_text(
        '{"packageManager":"pnpm@10.15.0"}',
        encoding="utf8",
    )
    monkeypatch.setattr("fluxfast.cli.shutil.which", lambda name: f"/bin/{name}")

    assert _frontend_command(tmp_path, "127.0.0.1", 3100) == [
        "pnpm",
        "run",
        "dev",
        "--hostname",
        "127.0.0.1",
        "--port",
        "3100",
    ]


def test_dev_supervisor_injects_private_backend_and_stops_both_processes(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    (tmp_path / "package.json").write_text("{}", encoding="utf8")
    created = []
    stopped = []

    class FakeProcess:
        def __init__(self, command, **kwargs):
            self.command = command
            self.kwargs = kwargs
            self.pid = 100 + len(created)
            created.append(self)

        def poll(self):
            return 7 if len(created) == 2 and self is created[1] else None

    monkeypatch.setattr("fluxfast.cli._available_port", lambda _host: 43123)
    monkeypatch.setattr(
        "fluxfast.cli._frontend_command",
        lambda _frontend, _host, _port: ["npm", "run", "dev"],
    )
    monkeypatch.setattr("fluxfast.cli._wait_for_backend", lambda *_args: None)
    monkeypatch.setattr("fluxfast.cli._stop_process", stopped.append)
    monkeypatch.setattr("fluxfast.cli.subprocess.Popen", FakeProcess)

    assert run_dev(DevConfig(app="backend.app:app", frontend=tmp_path)) == 7
    assert len(created) == 2
    assert created[0].command[:4] == [
        created[0].command[0],
        "-m",
        "uvicorn",
        "backend.app:app",
    ]
    frontend_environment = created[1].kwargs["env"]
    assert frontend_environment["FLUXFAST_BACKEND_URL"] == "http://127.0.0.1:43123"
    assert "NEXT_PUBLIC_FLUXFAST_BACKEND_URL" not in frontend_environment
    assert stopped == [created[1], created[0]]
