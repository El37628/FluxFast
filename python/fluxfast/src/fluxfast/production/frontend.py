"""Installed package-manager execution for a production frontend."""

from __future__ import annotations

import json
import shutil
from pathlib import Path

from .errors import ProductionFrontendError

_PACKAGE_MANAGER_CANDIDATES = (
    ("pnpm-lock.yaml", "pnpm"),
    ("yarn.lock", "yarn"),
    ("bun.lock", "bun"),
    ("bun.lockb", "bun"),
    ("package-lock.json", "npm"),
)
_SUPPORTED_PACKAGE_MANAGERS = frozenset(
    manager for _lockfile, manager in _PACKAGE_MANAGER_CANDIDATES
)


def detect_package_manager(frontend: Path) -> str:
    """Detect npm, pnpm, Yarn, or Bun without executing or installing anything."""

    try:
        manifest_value = json.loads(
            (frontend / "package.json").read_text(encoding="utf8")
        )
    except (OSError, json.JSONDecodeError):
        manifest: dict[str, object] = {}
    else:
        manifest = manifest_value if isinstance(manifest_value, dict) else {}
    return _detect_package_manager(frontend, manifest)


def production_frontend_command(
    frontend: Path,
    host: str,
    port: int,
) -> list[str]:
    """Build a local-only package-manager command for the production server."""

    manifest = _load_manifest(frontend)
    scripts = manifest.get("scripts")
    start_script = scripts.get("start") if isinstance(scripts, dict) else None
    if not isinstance(start_script, str) or not start_script.strip():
        raise ProductionFrontendError(
            f"Frontend package {frontend / 'package.json'} must define a non-empty "
            "scripts.start production command"
        )

    manager = _detect_package_manager(frontend, manifest)
    executable = shutil.which(manager)
    if executable is None:
        raise ProductionFrontendError(
            f"Could not find '{manager}' on PATH for frontend directory {frontend}"
        )

    separator = ["--"] if manager == "npm" else []
    return [
        executable,
        "run",
        "start",
        *separator,
        "--hostname",
        host,
        "--port",
        str(port),
    ]


def _load_manifest(frontend: Path) -> dict[str, object]:
    manifest_file = frontend / "package.json"
    try:
        manifest = json.loads(manifest_file.read_text(encoding="utf8"))
    except OSError as error:
        raise ProductionFrontendError(
            f"Could not read frontend package manifest {manifest_file}: {error}"
        ) from error
    except json.JSONDecodeError as error:
        raise ProductionFrontendError(
            f"Frontend package manifest {manifest_file} is not valid JSON"
        ) from error
    if not isinstance(manifest, dict):
        raise ProductionFrontendError(
            f"Frontend package manifest {manifest_file} must contain a JSON object"
        )
    return manifest


def _detect_package_manager(
    frontend: Path,
    manifest: dict[str, object],
) -> str:
    for lockfile, manager in _PACKAGE_MANAGER_CANDIDATES:
        if (frontend / lockfile).exists():
            return manager

    declared_manager = manifest.get("packageManager")
    if isinstance(declared_manager, str):
        candidate = declared_manager.split("@", 1)[0]
        if candidate in _SUPPORTED_PACKAGE_MANAGERS:
            return candidate
    return "npm"
