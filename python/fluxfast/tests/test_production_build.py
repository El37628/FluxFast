"""Tests for production build validation and package invocation."""

from __future__ import annotations

from pathlib import Path
from subprocess import CompletedProcess

import pytest

from fluxfast.production import ProductionBuildError
from fluxfast.production.build import (
    check_frontend_command,
    resolve_build_frontend,
    run_frontend_build,
)


def _frontend(path: Path) -> Path:
    path.mkdir(parents=True)
    (path / "package.json").write_text(
        '{"scripts":{"build":"next build"}}\n',
        encoding="utf8",
    )
    return path


def test_build_frontend_discovery_prefers_conventional_child(tmp_path: Path) -> None:
    root = _frontend(tmp_path / "project")
    child = _frontend(root / "frontend")

    assert resolve_build_frontend(None, cwd=root) == child


def test_build_frontend_discovery_supports_current_directory(tmp_path: Path) -> None:
    frontend = _frontend(tmp_path / "application")

    assert resolve_build_frontend(None, cwd=frontend) == frontend


def test_build_frontend_rejects_missing_explicit_package(tmp_path: Path) -> None:
    with pytest.raises(ProductionBuildError, match="No package.json"):
        resolve_build_frontend(tmp_path / "missing")


def test_build_frontend_reports_failed_discovery(tmp_path: Path) -> None:
    with pytest.raises(ProductionBuildError, match="Pass --frontend"):
        resolve_build_frontend(None, cwd=tmp_path)


def test_frontend_check_uses_local_adapter_and_read_only_flag(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    frontend = _frontend(tmp_path / "frontend")
    observed: dict[str, object] = {}
    monkeypatch.setattr(
        "fluxfast.production.build.package_manager_exec_command",
        lambda *args: ["/tools/pnpm", "exec", "fluxfast", "generate", "--check"],
    )

    def run(command: list[str], *, cwd: Path, check: bool) -> CompletedProcess[str]:
        observed.update(command=command, cwd=cwd, check=check)
        return CompletedProcess(command, 0)

    monkeypatch.setattr("fluxfast.production.build.subprocess.run", run)

    check_frontend_command(frontend, "generate")

    assert observed == {
        "command": ["/tools/pnpm", "exec", "fluxfast", "generate", "--check"],
        "cwd": frontend,
        "check": False,
    }


def test_frontend_check_reports_nonzero_status(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    frontend = _frontend(tmp_path / "frontend")
    monkeypatch.setattr(
        "fluxfast.production.build.package_manager_exec_command",
        lambda *args: ["adapter-check"],
    )
    monkeypatch.setattr(
        "fluxfast.production.build.subprocess.run",
        lambda *args, **kwargs: CompletedProcess(args[0], 7),
    )

    with pytest.raises(ProductionBuildError, match="status 7"):
        check_frontend_command(frontend, "init")


def test_frontend_build_returns_package_script_status(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    frontend = _frontend(tmp_path / "frontend")
    observed: dict[str, object] = {}
    monkeypatch.setattr(
        "fluxfast.production.build.package_manager_run_command",
        lambda *args: ["/tools/npm", "run", "build"],
    )

    def run(command: list[str], *, cwd: Path, check: bool) -> CompletedProcess[str]:
        observed.update(command=command, cwd=cwd, check=check)
        return CompletedProcess(command, 9)

    monkeypatch.setattr("fluxfast.production.build.subprocess.run", run)

    assert run_frontend_build(frontend) == 9
    assert observed == {
        "command": ["/tools/npm", "run", "build"],
        "cwd": frontend,
        "check": False,
    }
