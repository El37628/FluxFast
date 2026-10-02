"""Read-only FluxFast adapter selection shared by tooling and runtime hosts."""

from __future__ import annotations

import json
from enum import Enum
from pathlib import Path


class FrontendAdapter(str, Enum):
    """Implemented targets, selected from FluxFast packages rather than frameworks."""

    NEXT = "next"
    REACT = "react"


ADAPTER_PACKAGES = {
    FrontendAdapter.NEXT: ("@fluxfast/next",),
    FrontendAdapter.REACT: ("@fluxfast/vite",),
}


class FrontendAdapterError(RuntimeError):
    """Missing, ambiguous or invalid frontend adapter declarations."""


def detect_frontend_adapter(
    frontend: Path,
    adapter: str | None = None,
    *,
    legacy_default: FrontendAdapter | None = None,
) -> FrontendAdapter:
    """Inspect declarations only; never evaluate configuration or install packages.

    Explicit generation targets allow Codegen-only projects. Runtime callers may
    retain their historical Next default for manifests without adapter declarations;
    that default never masks malformed or ambiguous metadata.
    """

    selected = None
    if adapter is not None:
        try:
            selected = FrontendAdapter(adapter)
        except ValueError as error:
            raise FrontendAdapterError(
                f"Unsupported FluxFast adapter {adapter!r}. Supported adapters: next, react."
            ) from error
    package_json = frontend / "package.json"
    try:
        manifest = json.loads(package_json.read_text(encoding="utf8"))
    except (OSError, ValueError) as error:
        raise FrontendAdapterError(
            f"Could not read frontend package.json at {package_json}: {error}"
        ) from error
    if not isinstance(manifest, dict):
        raise FrontendAdapterError(
            f"Frontend package.json at {package_json} must contain a JSON object."
        )
    packages: set[str] = set()
    for section in ("dependencies", "devDependencies"):
        declarations = manifest.get(section, {})
        if not isinstance(declarations, dict) or any(
            not isinstance(value, str) or not value.strip()
            for value in declarations.values()
        ):
            raise FrontendAdapterError(
                f"Frontend package.json at {package_json} must contain an object of non-empty version strings in {section}."
            )
        packages.update(declarations)
    if selected is not None:
        return selected
    detected = [
        target
        for target, names in ADAPTER_PACKAGES.items()
        if any(name in packages for name in names)
    ]
    if len(detected) == 1:
        return detected[0]
    if len(detected) > 1:
        raise FrontendAdapterError(
            "Multiple FluxFast frontend adapters were declared. "
            "Use separate frontend projects, or select a generation target explicitly with --adapter next or --adapter react."
        )
    if legacy_default is not None:
        return legacy_default
    raise FrontendAdapterError(
        "Could not detect a supported FluxFast frontend adapter from package.json dependencies or devDependencies. "
        "Declare @fluxfast/next or @fluxfast/vite, or pass --adapter next or --adapter react explicitly. "
        "Framework packages such as next, react, and vite are not adapter declarations."
    )
