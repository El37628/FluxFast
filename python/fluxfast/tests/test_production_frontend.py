"""Tests for production package-manager detection and startup commands."""

from __future__ import annotations

from pathlib import Path

import pytest

from fluxfast.production import ProductionFrontendError
from fluxfast.production.frontend import (
    detect_package_manager,
    package_manager_exec_command,
    package_manager_run_command,
    production_frontend_command,
)


@pytest.mark.parametrize(
    ("lockfile", "expected"),
    [
        ("package-lock.json", "npm"),
        ("pnpm-lock.yaml", "pnpm"),
        ("yarn.lock", "yarn"),
        ("bun.lock", "bun"),
        ("bun.lockb", "bun"),
    ],
)
def test_detect_package_manager_uses_supported_lockfiles(
    tmp_path: Path,
    lockfile: str,
    expected: str,
) -> None:
    (tmp_path / "package.json").write_text(
        '{"packageManager":"npm@11.0.0"}\n',
        encoding="utf8",
    )
    (tmp_path / lockfile).touch()

    assert detect_package_manager(tmp_path) == expected


@pytest.mark.parametrize("manager", ["npm", "pnpm", "yarn", "bun"])
def test_detect_package_manager_uses_declared_manager_without_lockfile(
    tmp_path: Path,
    manager: str,
) -> None:
    (tmp_path / "package.json").write_text(
        f'{{"packageManager":"{manager}@1.2.3"}}\n',
        encoding="utf8",
    )

    assert detect_package_manager(tmp_path) == manager


@pytest.mark.parametrize(
    ("lockfile", "manager", "separator"),
    [
        ("package-lock.json", "npm", ["--"]),
        ("pnpm-lock.yaml", "pnpm", []),
        ("yarn.lock", "yarn", []),
        ("bun.lock", "bun", []),
    ],
)
def test_production_frontend_command_runs_installed_start_script(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    lockfile: str,
    manager: str,
    separator: list[str],
) -> None:
    (tmp_path / "package.json").write_text(
        '{"scripts":{"start":"next start"}}\n',
        encoding="utf8",
    )
    (tmp_path / lockfile).touch()
    monkeypatch.setattr(
        "fluxfast.production.frontend.shutil.which",
        lambda name: f"/tools/{name}",
    )

    assert production_frontend_command(tmp_path, "0.0.0.0", 3100) == [
        f"/tools/{manager}",
        "run",
        "start",
        *separator,
        "--hostname",
        "0.0.0.0",
        "--port",
        "3100",
    ]


def test_production_frontend_command_rejects_missing_start_script(
    tmp_path: Path,
) -> None:
    (tmp_path / "package.json").write_text("{}\n", encoding="utf8")

    with pytest.raises(ProductionFrontendError, match="scripts.start"):
        production_frontend_command(tmp_path, "127.0.0.1", 3000)


@pytest.mark.parametrize("contents", ["not-json", "[]"])
def test_production_frontend_command_rejects_invalid_manifest(
    tmp_path: Path,
    contents: str,
) -> None:
    (tmp_path / "package.json").write_text(contents, encoding="utf8")

    with pytest.raises(ProductionFrontendError, match="package manifest"):
        production_frontend_command(tmp_path, "127.0.0.1", 3000)


def test_production_frontend_command_rejects_unavailable_manager(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    (tmp_path / "package.json").write_text(
        '{"scripts":{"start":"next start"}}\n',
        encoding="utf8",
    )
    (tmp_path / "pnpm-lock.yaml").touch()
    monkeypatch.setattr(
        "fluxfast.production.frontend.shutil.which",
        lambda _name: None,
    )

    with pytest.raises(ProductionFrontendError, match="Could not find 'pnpm'"):
        production_frontend_command(tmp_path, "127.0.0.1", 3000)


@pytest.mark.parametrize(
    ("manager", "expected_prefix"),
    [
        ("npm", ["/tools/npm", "exec", "--no", "--"]),
        ("pnpm", ["/tools/pnpm", "exec"]),
        ("yarn", ["/tools/yarn", "exec"]),
        ("bun", ["/tools/bun", "x", "--no-install"]),
    ],
)
def test_package_manager_exec_never_uses_download_fallback(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    manager: str,
    expected_prefix: list[str],
) -> None:
    (tmp_path / "package.json").write_text(
        f'{{"packageManager":"{manager}@1.2.3"}}\n',
        encoding="utf8",
    )
    monkeypatch.setattr(
        "fluxfast.production.frontend.shutil.which",
        lambda name: f"/tools/{name}",
    )

    assert package_manager_exec_command(
        tmp_path,
        "fluxfast",
        "init",
        "--check",
    ) == [*expected_prefix, "fluxfast", "init", "--check"]


def test_package_manager_build_script_has_no_argument_separator(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    (tmp_path / "package.json").write_text(
        '{"scripts":{"build":"next build"}}\n',
        encoding="utf8",
    )
    monkeypatch.setattr(
        "fluxfast.production.frontend.shutil.which",
        lambda name: f"/tools/{name}",
    )

    assert package_manager_run_command(tmp_path, "build") == [
        "/tools/npm",
        "run",
        "build",
    ]
