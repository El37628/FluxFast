"""Read-only validation and package build orchestration for production."""

from __future__ import annotations

import subprocess
from pathlib import Path

from .errors import ProductionBuildError
from .frontend import package_manager_exec_command, package_manager_run_command


def resolve_build_frontend(
    frontend: Path | None,
    *,
    cwd: Path | None = None,
) -> Path:
    """Resolve an explicit frontend or the conventional monorepo layout."""

    if frontend is not None:
        resolved = frontend.resolve()
        if not (resolved / "package.json").is_file():
            raise ProductionBuildError(
                f"No package.json found in frontend directory {resolved}"
            )
        return resolved

    root = (cwd or Path.cwd()).resolve()
    for candidate in (root / "frontend", root):
        if (candidate / "package.json").is_file():
            return candidate
    raise ProductionBuildError(
        f"Could not detect a frontend from {root}. Pass --frontend PATH."
    )


def check_frontend_command(frontend: Path, command: str) -> None:
    """Run one FluxFast adapter check and fail without modifying source files."""

    result = subprocess.run(
        package_manager_exec_command(frontend, "fluxfast", command, "--check"),
        cwd=frontend,
        check=False,
        shell=False,
    )
    if result.returncode != 0:
        raise ProductionBuildError(
            f"Frontend validation failed: fluxfast {command} --check "
            f"exited with status {result.returncode}"
        )


def run_frontend_build(frontend: Path) -> int:
    """Run the consumer's existing package-manager production build script."""

    result = subprocess.run(
        package_manager_run_command(frontend, "build"),
        cwd=frontend,
        check=False,
        shell=False,
    )
    return int(result.returncode)
