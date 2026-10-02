"""Read-only diagnostics for a complete FluxFast production deployment."""

from __future__ import annotations

import inspect
import ipaddress
import json
import os
import re
import shutil
import subprocess
import sys
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

import anyio
from fastapi import FastAPI

from .. import __version__
from .._frontend_adapter import FrontendAdapter
from ..application_import import ApplicationImportError, load_fastapi_application
from ..cache import MemoryResourceCache
from ..live import MemoryLiveBroker
from .config import ProductionConfig
from .errors import ProductionFrontendError
from .frontend import (
    frontend_adapter,
    frontend_binary,
    frontend_build_exists,
    package_manager_exec_command,
)
from .redaction import safe_production_text

DiagnosticStatus = Literal["pass", "warning", "fail"]

_NODE_VERSION = re.compile(r"^v?(\d+)\.(\d+)\.(\d+)$")
_SUPPORTED_NODE_MAJORS = frozenset({22, 24})
_CONVENTIONAL_APPLICATIONS = (
    (Path("backend/main.py"), "backend.main:app"),
    (Path("backend.py"), "backend:app"),
    (Path("main.py"), "main:app"),
    (Path("app.py"), "app:app"),
)


@dataclass(frozen=True, slots=True)
class ProductionDiagnostic:
    """One stable, non-sensitive production diagnostic result."""

    section: str
    status: DiagnosticStatus
    message: str
    detail: str | None = None
    fix: str | None = None


@dataclass(frozen=True, slots=True)
class ProductionDiagnosticReport:
    """Read-only diagnostic results grouped for CLI rendering."""

    diagnostics: tuple[ProductionDiagnostic, ...]

    def is_valid(self, *, strict: bool = False) -> bool:
        """Return whether diagnostics satisfy the selected validation policy."""

        return self.blocking_count(strict=strict) == 0

    def blocking_count(self, *, strict: bool = False) -> int:
        """Count errors, and warnings when strict validation is enabled."""

        return sum(
            item.status == "fail" or (strict and item.status == "warning")
            for item in self.diagnostics
        )

    @property
    def valid(self) -> bool:
        return self.is_valid()

    @property
    def warning_count(self) -> int:
        return sum(item.status == "warning" for item in self.diagnostics)


def resolve_production_app(
    explicit: str | None,
    *,
    environment: Mapping[str, str] | None = None,
    cwd: Path | None = None,
) -> str | None:
    """Resolve an explicit, environment, or unambiguous conventional app import."""

    if explicit is not None:
        return explicit
    values = os.environ if environment is None else environment
    configured = values.get("FLUXFAST_APP")
    if configured:
        return configured

    root = (cwd or Path.cwd()).resolve()
    matches = [app for relative, app in _CONVENTIONAL_APPLICATIONS if (root / relative).is_file()]
    return matches[0] if len(matches) == 1 else None


def diagnose_production(config: ProductionConfig) -> ProductionDiagnosticReport:
    """Inspect production readiness without mutating source or generated files."""

    frontend = config.frontend.resolve()
    diagnostics: list[ProductionDiagnostic] = []
    try:
        adapter = frontend_adapter(frontend)
    except ProductionFrontendError as error:
        adapter = None
        diagnostics.append(
            ProductionDiagnostic(
                "Application", "fail", "Frontend adapter could not be selected",
                detail=str(error),
                fix="Declare exactly one FluxFast host: @fluxfast/next or @fluxfast/vite.",
            )
        )
    diagnostics.extend(_runtime_diagnostics(frontend, adapter))
    application, application_items = _application_diagnostics(config, frontend, adapter)
    diagnostics.extend(application_items)
    diagnostics.extend(_network_diagnostics(config))
    diagnostics.append(
        ProductionDiagnostic(
            "Workers",
            "pass",
            f"{config.workers} FastAPI worker{'s' if config.workers != 1 else ''}",
        )
    )
    diagnostics.extend(_distributed_diagnostics(application, config.workers))
    return ProductionDiagnosticReport(tuple(diagnostics))


def render_production_report(
    report: ProductionDiagnosticReport,
    *,
    strict: bool = False,
) -> str:
    """Render a deterministic human-readable report without sensitive values."""

    symbols = {"pass": "✓", "warning": "!", "fail": "✗"}
    sections: list[str] = []
    for item in report.diagnostics:
        if item.section not in sections:
            sections.append(item.section)

    lines = ["FluxFast Production Doctor"]
    for section in sections:
        lines.extend(("", _safe_display(section)))
        for item in report.diagnostics:
            if item.section != section:
                continue
            effective_status: DiagnosticStatus = (
                "fail" if strict and item.status == "warning" else item.status
            )
            lines.append(
                f"  {symbols[effective_status]} {_safe_display(item.message)}"
            )
            if item.detail:
                lines.append(f"    {_safe_display(item.detail)}")
            if item.fix:
                lines.append(f"    Fix: {_safe_display(item.fix)}")

    lines.extend(("", "Result"))
    blocking = report.blocking_count(strict=strict)
    if blocking:
        subject = "Strict production configuration" if strict else "Production configuration"
        lines.append(
            f"  ✗ {subject} has {blocking} blocking "
            f"problem{'s' if blocking != 1 else ''}."
        )
    elif report.warning_count:
        lines.append(
            f"  ! Production configuration is runnable with "
            f"{report.warning_count} risk warning"
            f"{'s' if report.warning_count != 1 else ''}."
        )
    else:
        lines.append("  ✓ Production configuration looks ready.")
    return "\n".join(lines) + "\n"


def _safe_display(value: str, *, limit: int = 240) -> str:
    """Keep diagnostic values on one bounded, terminal-safe line."""

    return safe_production_text(value, limit=limit)


def _runtime_diagnostics(
    frontend: Path, adapter: FrontendAdapter | None
) -> list[ProductionDiagnostic]:
    diagnostics = [
        ProductionDiagnostic(
            "Runtime",
            "pass" if sys.version_info >= (3, 11) else "fail",
            f"Python {sys.version_info.major}.{sys.version_info.minor}",
            None if sys.version_info >= (3, 11) else "FluxFast requires Python 3.11 or newer.",
        )
    ]
    node = _node_version()
    if node is None:
        diagnostics.append(
            ProductionDiagnostic(
                "Runtime",
                "fail",
                "Supported Node.js runtime was not found",
                fix=(
                    "Install Node.js 22.12+ or 24 and ensure node is on PATH."
                    if adapter is FrontendAdapter.REACT
                    else "Install Node.js 22 or 24 and ensure node is on PATH."
                ),
            )
        )
    else:
        major, minor, patch = node
        supported = major in _SUPPORTED_NODE_MAJORS and not (
            adapter is FrontendAdapter.REACT and major == 22 and minor < 12
        )
        diagnostics.append(
            ProductionDiagnostic(
                "Runtime",
                "pass" if supported else "fail",
                f"Node.js {major}.{minor}.{patch}",
                None if supported else (
                    "React/Vite requires Node.js 22.12+ or 24."
                    if adapter is FrontendAdapter.REACT
                    else "FluxFast supports Node.js 22 and 24."
                ),
            )
        )

    if adapter is None:
        return diagnostics
    packages = (
        ("@fluxfast/core", "@fluxfast/react", "@fluxfast/vite")
        if adapter is FrontendAdapter.REACT
        else ("@fluxfast/core", "@fluxfast/next")
    )
    versions = {
        "Python": __version__,
        **{package: _package_version(frontend, package) for package in packages},
    }
    installed = [version for version in versions.values() if version is not None]
    if len(installed) != len(versions):
        diagnostics.append(
            ProductionDiagnostic(
                "Runtime",
                "fail",
                "FluxFast package versions could not all be resolved",
                fix="Install the frontend dependencies before running production diagnostics.",
            )
        )
    elif len(set(installed)) == 1:
        diagnostics.append(
            ProductionDiagnostic(
                "Runtime",
                "pass",
                f"FluxFast packages synchronized at {installed[0]}",
            )
        )
    else:
        summary = ", ".join(f"{name} {version}" for name, version in versions.items())
        diagnostics.append(
            ProductionDiagnostic(
                "Runtime",
                "warning",
                "FluxFast package versions are not synchronized",
                detail=summary,
                fix="Install matching FluxFast package versions for production features.",
            )
        )
    return diagnostics


def _application_diagnostics(
    config: ProductionConfig,
    frontend: Path,
    adapter: FrontendAdapter | None,
) -> tuple[FastAPI | None, list[ProductionDiagnostic]]:
    diagnostics: list[ProductionDiagnostic] = []
    if (frontend / "package.json").is_file():
        diagnostics.append(
            ProductionDiagnostic("Application", "pass", "Frontend package exists")
        )
    else:
        diagnostics.append(
            ProductionDiagnostic(
                "Application",
                "fail",
                "Frontend package is missing",
                fix="Pass --frontend PATH for the initialized frontend application.",
            )
        )

    if adapter is not None:
        built = frontend_build_exists(frontend)
        diagnostics.append(
            ProductionDiagnostic(
                "Application",
                "pass" if built else "fail",
                "Frontend production build exists" if built else "Frontend production build is missing",
                fix=None if built else "Run fluxfast build before fluxfast start.",
            )
        )
        name = "React/Vite" if adapter is FrontendAdapter.REACT else "Next.js"
        binary = "fluxfast-vite" if adapter is FrontendAdapter.REACT else "fluxfast"
        for command, success, failure in (
            ("init", f"{name} adapter is initialized", f"{name} adapter initialization is incomplete"),
            ("generate", "Generated FluxFast files are current", "Generated FluxFast files are missing or stale"),
        ):
            status = _frontend_check(frontend, command)
            diagnostics.append(
                ProductionDiagnostic(
                    "Application", "pass" if status else "fail",
                    success if status else failure,
                    fix=None if status else f"Run {binary} {command} in the frontend project.",
                )
            )

    application = _load_application(config.app)
    if application is None:
        diagnostics.append(
            ProductionDiagnostic(
                "Application",
                "fail",
                "FastAPI import could not be resolved",
                detail=f"Import: {config.app}",
                fix="Pass --app MODULE:ATTRIBUTE or set FLUXFAST_APP.",
            )
        )
        return None, diagnostics

    diagnostics.append(
        ProductionDiagnostic("Application", "pass", "FastAPI import resolved")
    )
    if not hasattr(application.state, "fluxfast_cache") or not hasattr(
        application.state,
        "fluxfast_live",
    ):
        diagnostics.append(
            ProductionDiagnostic(
                "Application",
                "fail",
                "FastAPI application is not initialized with FluxFast",
            )
        )
        return None, diagnostics
    diagnostics.append(
        ProductionDiagnostic("Application", "pass", "FluxFast runtime is initialized")
    )
    return application, diagnostics


def _network_diagnostics(config: ProductionConfig) -> list[ProductionDiagnostic]:
    backend_is_loopback = _is_loopback(config.backend_host)
    return [
        ProductionDiagnostic(
            "Networking",
            "pass",
            f"Public application: {config.host}:{config.port}",
        ),
        ProductionDiagnostic(
            "Networking",
            "pass" if backend_is_loopback else "warning",
            f"FastAPI internal: {config.backend_host}:{config.backend_port}",
            None
            if backend_is_loopback
            else "The backend is not bound to a loopback address.",
            None
            if backend_is_loopback
            else "Use --backend-host 127.0.0.1 unless external access is intentional.",
        ),
        ProductionDiagnostic(
            "Networking",
            "pass",
            "Public and internal ports do not conflict",
        ),
    ]


def _distributed_diagnostics(
    application: FastAPI | None,
    workers: int,
) -> list[ProductionDiagnostic]:
    if application is None:
        return [
            ProductionDiagnostic(
                "Distributed runtime",
                "fail",
                "Cache and Live Broker configuration could not be inspected",
            )
        ]

    cache = application.state.fluxfast_cache
    live = application.state.fluxfast_live
    broker = getattr(live, "broker", None)
    diagnostics: list[ProductionDiagnostic] = []

    if workers > 1 and isinstance(cache, MemoryResourceCache):
        diagnostics.append(
            ProductionDiagnostic(
                "Distributed runtime",
                "warning",
                f"Positive-TTL resources are process-local across {workers} FastAPI workers",
                fix="Configure RedisResourceCache when shared resource caching is required.",
            )
        )
    else:
        diagnostics.append(
            ProductionDiagnostic(
                "Distributed runtime",
                "pass",
                type(cache).__name__,
            )
        )

    if workers > 1 and isinstance(broker, MemoryLiveBroker):
        diagnostics.append(
            ProductionDiagnostic(
                "Distributed runtime",
                "warning",
                f"Live Resource events are process-local across {workers} FastAPI workers",
                fix="Configure RedisLiveBroker for multi-worker realtime synchronization.",
            )
        )
    elif broker is None:
        diagnostics.append(
            ProductionDiagnostic(
                "Distributed runtime",
                "fail",
                "Live Broker configuration could not be inspected",
            )
        )
    else:
        diagnostics.append(
            ProductionDiagnostic(
                "Distributed runtime",
                "pass",
                type(broker).__name__,
            )
        )

    seen: set[int] = set()
    for component in (cache, broker):
        if component is None or id(component) in seen:
            continue
        seen.add(id(component))
        healthcheck = getattr(component, "healthcheck", None)
        if not callable(healthcheck):
            continue
        healthy = _run_healthcheck(healthcheck)
        diagnostics.append(
            ProductionDiagnostic(
                "Distributed runtime",
                "pass" if healthy else "fail",
                f"{type(component).__name__} is reachable"
                if healthy
                else f"{type(component).__name__} is not reachable",
            )
        )
    return diagnostics


def _node_version() -> tuple[int, int, int] | None:
    executable = shutil.which("node")
    if executable is None:
        return None
    try:
        result = subprocess.run(
            [executable, "--version"],
            check=False,
            capture_output=True,
            shell=False,
            text=True,
            timeout=5,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    match = _NODE_VERSION.fullmatch(result.stdout.strip()) if result.returncode == 0 else None
    return tuple(map(int, match.groups())) if match else None  # type: ignore[return-value]


def _package_version(frontend: Path, package: str) -> str | None:
    relative = Path(*package.split("/")) / "package.json"
    roots = (frontend, *frontend.parents)
    candidates: list[Path] = []
    hosts = (
        ("vite", "react")
        if frontend_adapter(frontend) is FrontendAdapter.REACT
        else ("next",)
    )
    # npm's nested dependencies and pnpm's real package siblings need no Node
    # evaluation. React/Vite hosts must not depend on Next for version discovery.
    for root in roots:
        candidates.append(root / "node_modules" / relative)
        for host in hosts:
            installed = root / "node_modules" / "@fluxfast" / host
            if installed.is_dir():
                candidates.extend((
                    installed / "node_modules" / relative,
                    installed.resolve().parent.parent / relative,
                ))
    for candidate in candidates:
        try:
            value = json.loads(candidate.read_text(encoding="utf8"))
        except (OSError, json.JSONDecodeError):
            continue
        if isinstance(value, dict) and isinstance(value.get("version"), str):
            return value["version"]
    return None


def _frontend_check(frontend: Path, command: str) -> bool:
    try:
        arguments = package_manager_exec_command(
            frontend,
            frontend_binary(frontend),
            command,
            "--check",
        )
        result = subprocess.run(
            arguments,
            cwd=frontend,
            check=False,
            shell=False,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=30,
        )
    except (OSError, subprocess.TimeoutExpired, RuntimeError):
        return False
    return result.returncode == 0


def _load_application(app_import: str) -> FastAPI | None:
    try:
        return load_fastapi_application(app_import)
    except ApplicationImportError:
        return None


def _is_loopback(host: str) -> bool:
    normalized = host.strip().casefold().strip("[]")
    if normalized == "localhost":
        return True
    try:
        return ipaddress.ip_address(normalized).is_loopback
    except ValueError:
        return False


def _run_healthcheck(
    healthcheck: Callable[[], bool | Awaitable[bool]],
) -> bool:
    async def check() -> bool:
        try:
            with anyio.fail_after(3):
                result = healthcheck()
                if inspect.isawaitable(result):
                    result = await result
                return result is True
        except Exception:  # noqa: BLE001 - never expose infrastructure errors.
            return False

    try:
        return anyio.run(check)
    except RuntimeError:
        return False
