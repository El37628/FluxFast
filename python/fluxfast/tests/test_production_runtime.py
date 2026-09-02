"""Tests for concrete production process construction and validation."""

from __future__ import annotations

from pathlib import Path

import pytest

from fluxfast.production import (
    ProductionBuildMissingError,
    ProductionConfig,
    ProductionValidationError,
    create_production_supervisor,
    run_production,
)
from fluxfast.production.runtime import _connection_host, _http_url


def _built_frontend(path: Path) -> Path:
    (path / ".next").mkdir(parents=True)
    (path / "package.json").write_text(
        '{"scripts":{"start":"next start"}}\n',
        encoding="utf8",
    )
    (path / "package-lock.json").touch()
    (path / ".next" / "BUILD_ID").write_text("build-id\n", encoding="utf8")
    return path


def test_production_runtime_builds_safe_child_commands_and_private_environment(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    frontend = _built_frontend(tmp_path / "frontend")
    monkeypatch.setattr(
        "fluxfast.production.frontend.shutil.which",
        lambda manager: f"/tools/{manager}",
    )
    monkeypatch.setenv("NEXT_PUBLIC_FLUXFAST_BACKEND_URL", "https://public.invalid")
    monkeypatch.setenv("APPLICATION_SECRET", "kept-private")
    probe_addresses: list[tuple[str, int]] = []
    readiness_urls: list[str] = []

    def probe(host: str, port: int):  # type: ignore[no-untyped-def]
        probe_addresses.append((host, port))
        return lambda: False

    monkeypatch.setattr("fluxfast.production.runtime.tcp_readiness_probe", probe)
    monkeypatch.setattr(
        "fluxfast.production.runtime.http_readiness_probe",
        lambda url: readiness_urls.append(url) or (lambda: False),
    )
    config = ProductionConfig(
        app="backend.main:app",
        frontend=frontend,
        host="0.0.0.0",
        port=3100,
        backend_host="::",
        backend_port=8124,
        workers=4,
    )

    supervisor = create_production_supervisor(config)

    assert supervisor.backend.command == (
        supervisor.backend.command[0],
        "-m",
        "uvicorn",
        "backend.main:app",
        "--host",
        "::",
        "--port",
        "8124",
        "--workers",
        "4",
    )
    assert "--reload" not in supervisor.backend.command
    assert supervisor.frontend.command == (
        "/tools/npm",
        "run",
        "start",
        "--",
        "--hostname",
        "0.0.0.0",
        "--port",
        "3100",
    )
    assert supervisor.frontend.cwd == frontend.resolve()
    assert supervisor.frontend.environment is not None
    assert supervisor.frontend.environment["NODE_ENV"] == "production"
    assert (
        supervisor.frontend.environment["FLUXFAST_BACKEND_URL"]
        == "http://[::1]:8124"
    )
    assert supervisor.frontend.environment["FLUXFAST_PRODUCTION_START"] == "1"
    assert "NEXT_PUBLIC_FLUXFAST_BACKEND_URL" not in supervisor.frontend.environment
    assert supervisor.frontend.environment["APPLICATION_SECRET"] == "kept-private"
    assert readiness_urls == ["http://[::1]:8124/_fluxfast/readyz"]
    assert probe_addresses == [("127.0.0.1", 3100)]


def test_production_runtime_requires_frontend_package(tmp_path: Path) -> None:
    config = ProductionConfig(app="backend:app", frontend=tmp_path)

    with pytest.raises(ProductionValidationError, match="No package.json"):
        create_production_supervisor(config)


def test_production_runtime_requires_completed_next_build(tmp_path: Path) -> None:
    (tmp_path / "package.json").write_text("{}\n", encoding="utf8")
    config = ProductionConfig(app="backend:app", frontend=tmp_path)

    with pytest.raises(ProductionBuildMissingError, match="fluxfast build"):
        create_production_supervisor(config)


def test_production_runtime_requires_frontend_start_script(tmp_path: Path) -> None:
    (tmp_path / ".next").mkdir()
    (tmp_path / "package.json").write_text("{}\n", encoding="utf8")
    (tmp_path / ".next" / "BUILD_ID").touch()
    config = ProductionConfig(app="backend:app", frontend=tmp_path)

    with pytest.raises(ProductionValidationError, match="scripts.start"):
        create_production_supervisor(config)


@pytest.mark.parametrize(
    ("host", "expected"),
    [("0.0.0.0", "127.0.0.1"), ("::", "::1"), ("localhost", "localhost")],
)
def test_connection_host_uses_loopback_for_wildcard_bind(
    host: str,
    expected: str,
) -> None:
    assert _connection_host(host) == expected


def test_http_url_brackets_ipv6_addresses() -> None:
    assert _http_url("::1", 8123) == "http://[::1]:8123"
    assert _http_url("127.0.0.1", 8123) == "http://127.0.0.1:8123"


def test_run_production_forwards_supervisor_status_and_logs_topology(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    config = ProductionConfig(app="backend:app", frontend=tmp_path, workers=3)

    class FakeSupervisor:
        def run(self) -> int:
            return 7

    monkeypatch.setattr(
        "fluxfast.production.runtime.create_production_supervisor",
        lambda _config: FakeSupervisor(),
    )

    assert run_production(config) == 7
    assert capsys.readouterr().out.splitlines() == [
        "[fluxfast] production runtime starting",
        "[fluxfast] FastAPI: 127.0.0.1:8123",
        "[fluxfast] FastAPI workers: 3",
        "[fluxfast] public application: 0.0.0.0:3000",
    ]
