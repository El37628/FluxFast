"""Tests for read-only FluxFast production diagnostics."""

from __future__ import annotations

from pathlib import Path
from subprocess import CompletedProcess

import pytest
from fastapi import FastAPI

from fluxfast import FluxFast, RedisLiveBroker, RedisResourceCache
from fluxfast.production import (
    ProductionConfig,
    ProductionDiagnostic,
    ProductionDiagnosticReport,
    diagnose_production,
    render_production_report,
    resolve_production_app,
)


def _frontend(path: Path, *, core: str = "0.6.0", next_: str = "0.6.0") -> Path:
    path.mkdir()
    (path / "package.json").write_text(
        '{"packageManager":"pnpm@10.15.0"}\n',
        encoding="utf8",
    )
    (path / "pnpm-lock.yaml").touch()
    (path / ".next").mkdir()
    (path / ".next" / "BUILD_ID").write_text("build\n", encoding="utf8")
    for package, version in (("core", core), ("next", next_)):
        package_root = path / "node_modules" / "@fluxfast" / package
        package_root.mkdir(parents=True)
        (package_root / "package.json").write_text(
            f'{{"version":"{version}"}}\n',
            encoding="utf8",
        )
    return path


def _statuses(report: ProductionDiagnosticReport) -> dict[str, str]:
    return {item.message: item.status for item in report.diagnostics}


def test_single_worker_production_diagnostics_are_ready(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    frontend = _frontend(tmp_path / "frontend")
    app = FastAPI()
    FluxFast(app)
    monkeypatch.setattr(
        "fluxfast.production.diagnostics._node_version",
        lambda: (24, 19, 0),
    )
    monkeypatch.setattr(
        "fluxfast.production.diagnostics._frontend_check",
        lambda _frontend, _command: True,
    )
    monkeypatch.setattr(
        "fluxfast.production.diagnostics._load_application",
        lambda _app: app,
    )

    report = diagnose_production(
        ProductionConfig(app="backend:app", frontend=frontend)
    )
    rendered = render_production_report(report)

    assert report.valid is True
    assert report.warning_count == 0
    expected = {
        "Node.js 24.19.0": "pass",
        "FluxFast packages synchronized at 0.6.0": "pass",
        "Frontend production build exists": "pass",
        "Next.js adapter is initialized": "pass",
        "Generated FluxFast files are current": "pass",
        "FastAPI import resolved": "pass",
        "FluxFast runtime is initialized": "pass",
        "1 FastAPI worker": "pass",
        "MemoryResourceCache": "pass",
        "MemoryLiveBroker": "pass",
    }
    assert expected.items() <= _statuses(report).items()
    assert "Production configuration looks ready" in rendered


def test_multi_worker_memory_runtime_reports_two_nonblocking_risks(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    frontend = _frontend(tmp_path / "frontend")
    app = FastAPI()
    FluxFast(app)
    monkeypatch.setattr(
        "fluxfast.production.diagnostics._node_version",
        lambda: (22, 20, 0),
    )
    monkeypatch.setattr(
        "fluxfast.production.diagnostics._frontend_check",
        lambda _frontend, _command: True,
    )
    monkeypatch.setattr(
        "fluxfast.production.diagnostics._load_application",
        lambda _app: app,
    )

    report = diagnose_production(
        ProductionConfig(app="backend:app", frontend=frontend, workers=4)
    )
    warnings = [item for item in report.diagnostics if item.status == "warning"]

    assert report.valid is True
    assert report.warning_count == 2
    assert [item.message for item in warnings] == [
        "Positive-TTL resources are process-local across 4 FastAPI workers",
        "Live Resource events are process-local across 4 FastAPI workers",
    ]
    assert warnings[0].fix == (
        "Configure RedisResourceCache when shared resource caching is required."
    )
    assert warnings[1].fix == (
        "Configure RedisLiveBroker for multi-worker realtime synchronization."
    )
    assert "runnable with 2 risk warnings" in render_production_report(report)


def test_strict_report_converts_risk_warnings_to_blocking_failures() -> None:
    report = ProductionDiagnosticReport(
        (
            ProductionDiagnostic("Workers", "pass", "4 FastAPI workers"),
            ProductionDiagnostic(
                "Distributed runtime",
                "warning",
                "Live Resource events are process-local across 4 FastAPI workers",
                fix="Configure RedisLiveBroker or use --workers 1.",
            ),
        )
    )

    rendered = render_production_report(report, strict=True)

    assert report.valid is True
    assert report.is_valid(strict=True) is False
    assert report.blocking_count(strict=True) == 1
    assert "  ✗ Live Resource events are process-local" in rendered
    assert "  ! Live Resource events are process-local" not in rendered
    assert "Strict production configuration has 1 blocking problem" in rendered


@pytest.mark.parametrize("healthy", [True, False])
def test_redis_diagnostics_probe_owned_dependencies_without_leaking_errors(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    healthy: bool,
) -> None:
    class RedisClient:
        async def ping(self) -> bool:
            if not healthy:
                raise ConnectionError("redis://user:secret@private.invalid/0")
            return True

    client = RedisClient()
    cache = RedisResourceCache(client, namespace="private-tenant")  # type: ignore[arg-type]
    broker = RedisLiveBroker(client)  # type: ignore[arg-type]
    app = FastAPI()
    FluxFast(app, cache=cache, live_broker=broker)
    frontend = _frontend(tmp_path / "frontend")
    monkeypatch.setattr(
        "fluxfast.production.diagnostics._node_version",
        lambda: (24, 19, 0),
    )
    monkeypatch.setattr(
        "fluxfast.production.diagnostics._frontend_check",
        lambda _frontend, _command: True,
    )
    monkeypatch.setattr(
        "fluxfast.production.diagnostics._load_application",
        lambda _app: app,
    )

    report = diagnose_production(
        ProductionConfig(app="backend:app", frontend=frontend, workers=4)
    )
    rendered = render_production_report(report)

    assert report.warning_count == 0
    assert report.valid is healthy
    expected = "reachable" if healthy else "not reachable"
    assert f"RedisResourceCache is {expected}" in rendered
    assert f"RedisLiveBroker is {expected}" in rendered
    assert "secret" not in rendered
    assert "private-tenant" not in rendered
    assert "redis://" not in rendered


def test_import_and_frontend_failures_are_blocking_and_redacted(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    frontend = _frontend(tmp_path / "frontend")
    (frontend / ".next" / "BUILD_ID").unlink()
    monkeypatch.setattr(
        "fluxfast.production.diagnostics._node_version",
        lambda: (24, 19, 0),
    )
    monkeypatch.setattr(
        "fluxfast.production.diagnostics._frontend_check",
        lambda _frontend, command: command == "init",
    )
    monkeypatch.setattr(
        "fluxfast.application_import.importlib.import_module",
        lambda _module: (_ for _ in ()).throw(
            RuntimeError("postgres://admin:secret@private.invalid")
        ),
    )

    report = diagnose_production(
        ProductionConfig(app="backend:app", frontend=frontend)
    )
    rendered = render_production_report(report)

    assert report.valid is False
    assert "Frontend production build is missing" in rendered
    assert "Generated FluxFast files are missing or stale" in rendered
    assert "FastAPI import could not be resolved" in rendered
    assert "secret" not in rendered
    assert "postgres" not in rendered


def test_unsynchronized_packages_are_visible_but_nonblocking(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    frontend = _frontend(tmp_path / "frontend", next_="0.5.0")
    app = FastAPI()
    FluxFast(app)
    monkeypatch.setattr(
        "fluxfast.production.diagnostics._node_version",
        lambda: (24, 19, 0),
    )
    monkeypatch.setattr(
        "fluxfast.production.diagnostics._frontend_check",
        lambda _frontend, _command: True,
    )
    monkeypatch.setattr(
        "fluxfast.production.diagnostics._load_application",
        lambda _app: app,
    )

    report = diagnose_production(
        ProductionConfig(app="backend:app", frontend=frontend)
    )

    assert report.valid is True
    assert report.warning_count == 1
    assert "FluxFast package versions are not synchronized" in render_production_report(
        report
    )


def test_frontend_diagnostic_executes_only_installed_read_only_check(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from fluxfast.production.diagnostics import _frontend_check

    frontend = _frontend(tmp_path / "frontend")
    observed: dict[str, object] = {}
    monkeypatch.setattr(
        "fluxfast.production.diagnostics.package_manager_exec_command",
        lambda *args: ["/tools/pnpm", "exec", "fluxfast", "init", "--check"],
    )

    def run(command: list[str], **kwargs: object) -> CompletedProcess[str]:
        observed.update(command=command, **kwargs)
        return CompletedProcess(command, 0)

    monkeypatch.setattr("fluxfast.production.diagnostics.subprocess.run", run)

    assert _frontend_check(frontend, "init") is True
    assert observed["command"] == [
        "/tools/pnpm",
        "exec",
        "fluxfast",
        "init",
        "--check",
    ]
    assert observed["cwd"] == frontend
    assert observed["check"] is False
    assert observed["timeout"] == 30


def test_production_app_resolution_is_explicit_then_environment_then_convention(
    tmp_path: Path,
) -> None:
    assert resolve_production_app(
        "service:application",
        environment={"FLUXFAST_APP": "ignored:app"},
        cwd=tmp_path,
    ) == "service:application"
    assert resolve_production_app(
        None,
        environment={"FLUXFAST_APP": "configured:app"},
        cwd=tmp_path,
    ) == "configured:app"

    backend = tmp_path / "backend"
    backend.mkdir()
    (backend / "main.py").touch()
    assert resolve_production_app(None, environment={}, cwd=tmp_path) == (
        "backend.main:app"
    )

    (tmp_path / "app.py").touch()
    assert resolve_production_app(None, environment={}, cwd=tmp_path) is None


def test_report_rendering_has_stable_sections_and_result() -> None:
    report = ProductionDiagnosticReport(
        (
            ProductionDiagnostic("Runtime", "pass", "Python 3.13"),
            ProductionDiagnostic(
                "Workers",
                "warning",
                "Process-local cache",
                fix="Configure RedisResourceCache.",
            ),
        )
    )

    assert render_production_report(report) == (
        "FluxFast Production Doctor\n"
        "\n"
        "Runtime\n"
        "  ✓ Python 3.13\n"
        "\n"
        "Workers\n"
        "  ! Process-local cache\n"
        "    Fix: Configure RedisResourceCache.\n"
        "\n"
        "Result\n"
        "  ! Production configuration is runnable with 1 risk warning.\n"
    )


def test_report_rendering_neutralizes_control_characters() -> None:
    report = ProductionDiagnosticReport(
        (
            ProductionDiagnostic(
                "Runtime\nforged",
                "fail",
                "Invalid metadata\x1b[31m",
                detail="value\r\nforged",
                fix="replace\tmetadata",
            ),
        )
    )

    rendered = render_production_report(report)

    assert "Runtime?forged" in rendered
    assert "Invalid metadata?[31m" in rendered
    assert "value??forged" in rendered
    assert "replace?metadata" in rendered
    assert "\x1b" not in rendered
