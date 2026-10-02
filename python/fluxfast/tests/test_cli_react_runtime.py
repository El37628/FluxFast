"""React host selection, immutable startup and existing supervisor regression tests."""

from __future__ import annotations

import json
from pathlib import Path
from subprocess import CompletedProcess

import pytest
from fastapi import FastAPI

from fluxfast import FluxFast, __version__
from fluxfast.cli import DevConfig, DevServerError, _frontend_command, main, run_dev
from fluxfast.production import (
    ProductionBuildMissingError,
    ProductionConfig,
    ProductionFrontendError,
    create_production_supervisor,
    diagnose_production,
    render_production_report,
)
from fluxfast.production.build import check_frontend_command, run_frontend_build
from fluxfast.production.diagnostics import _frontend_check, _package_version
from fluxfast.production.frontend import (
    frontend_build_exists,
    production_frontend_command,
)


def frontend(path: Path, manager: str = "npm") -> Path:
    path.mkdir(parents=True)
    (path / "package.json").write_text(
        json.dumps(
            {
                "packageManager": manager + "@1.0.0",
                "dependencies": {"@fluxfast/vite": __version__},
                "scripts": {
                    "dev": "vite",
                    "build": "vite build",
                    "start": "vite preview",
                    "fluxfast:dev": "fluxfast-vite dev --config fluxfast.vite.config.mjs",
                    "fluxfast:build": "fluxfast-vite build --config fluxfast.vite.config.mjs",
                    "fluxfast:start": "fluxfast-vite start",
                },
            }
        ),
        encoding="utf8",
    )
    return path


def built(path: Path) -> Path:
    output = path / "dist" / "fluxfast"
    (output / "server").mkdir(parents=True)
    (output / "host.json").write_text(
        '{"version":1,"template":"fluxfast.html","assets":[]}', encoding="utf8"
    )
    (output / "server" / "renderer.mjs").write_text(
        "// validated by the Node host", encoding="utf8"
    )
    return path


@pytest.mark.parametrize("manager", ["npm", "pnpm", "yarn", "bun"])
@pytest.mark.parametrize("command", ["dev", "build", "start"])
def test_python_selects_scoped_react_scripts_and_preserves_the_spa(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, manager: str, command: str
):
    root = frontend(tmp_path / "frontend", manager)
    before = (root / "package.json").read_bytes()
    monkeypatch.setattr("shutil.which", lambda name: f"/tools/{name}")
    separator = ["--"] if manager == "npm" else []
    expected = [f"/tools/{manager}", "run", "fluxfast:" + command]
    if command == "dev":
        result = _frontend_command(root, "127.0.0.1", 3100)
    elif command == "start":
        result = production_frontend_command(root, "127.0.0.1", 3100)
    else:
        observed = []
        monkeypatch.setattr(
            "fluxfast.production.build.subprocess.run",
            lambda args, **kwargs: (
                observed.append((args, kwargs)) or CompletedProcess(args, 7)
            ),
        )
        assert run_frontend_build(root) == 7
        result, kwargs = observed[0]
        assert kwargs == {"cwd": root, "check": False, "shell": False}
    if command != "build":
        expected.extend([*separator, "--hostname", "127.0.0.1", "--port", "3100"])
    assert result == expected
    assert (root / "package.json").read_bytes() == before


@pytest.mark.parametrize("command", ["dev", "build", "start"])
def test_react_does_not_fall_back_to_existing_spa_scripts(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, command: str
):
    root = frontend(tmp_path / "frontend")
    manifest = json.loads((root / "package.json").read_text())
    del manifest["scripts"]["fluxfast:" + command]
    (root / "package.json").write_text(json.dumps(manifest))
    monkeypatch.setattr("shutil.which", lambda name: "/tools/" + name)
    with pytest.raises(
        (DevServerError, ProductionFrontendError), match="scripts.fluxfast:" + command
    ):
        if command == "dev":
            _frontend_command(root, "localhost", 3000)
        elif command == "start":
            production_frontend_command(root, "localhost", 3000)
        else:
            run_frontend_build(root)


@pytest.mark.parametrize("command", ["init", "generate"])
@pytest.mark.parametrize("doctor", [False, True])
def test_react_checks_invoke_only_the_host_cli_read_only(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, command: str, doctor: bool
):
    root = frontend(tmp_path / "frontend")
    monkeypatch.setattr("shutil.which", lambda name: "/tools/" + name)
    observed = []
    monkeypatch.setattr(
        "subprocess.run",
        lambda args, **kwargs: (
            observed.append((args, kwargs)) or CompletedProcess(args, 0)
        ),
    )
    if doctor:
        assert _frontend_check(root, command)
    else:
        check_frontend_command(root, command)
    args, kwargs = observed[0]
    assert args == [
        "/tools/npm",
        "exec",
        "--no",
        "--",
        "fluxfast-vite",
        command,
        "--check",
    ]
    assert kwargs["shell"] is False and kwargs["check"] is False
    assert kwargs["cwd"] == root
    if doctor:
        assert kwargs["timeout"] == 30


def test_react_production_uses_existing_two_child_supervisor_and_private_environment(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
):
    root = built(frontend(tmp_path / "frontend"))
    (root / "fluxfast.vite.config.mjs").write_text(
        "throw new Error('must not evaluate on start')"
    )
    monkeypatch.setattr("shutil.which", lambda name: "/tools/" + name)
    monkeypatch.setenv("NEXT_PUBLIC_FLUXFAST_BACKEND_URL", "https://forbidden.invalid")
    monkeypatch.setenv("APPLICATION_SECRET", "private")
    addresses = []
    monkeypatch.setattr(
        "fluxfast.production.runtime.http_readiness_probe",
        lambda url: addresses.append(url) or (lambda: True),
    )
    monkeypatch.setattr(
        "fluxfast.production.runtime.tcp_readiness_probe",
        lambda host, port: addresses.append((host, port)) or (lambda: True),
    )
    config = ProductionConfig(
        app="backend:app",
        frontend=root,
        host="0.0.0.0",
        port=3100,
        backend_host="::",
        backend_port=8124,
        workers=3,
    )
    supervisor = create_production_supervisor(config)
    assert supervisor.frontend.name == "React/Vite"
    assert supervisor.frontend.command == (
        "/tools/npm",
        "run",
        "fluxfast:start",
        "--",
        "--hostname",
        "0.0.0.0",
        "--port",
        "3100",
    )
    assert supervisor.frontend.cwd == root.resolve()
    assert supervisor.backend.command[-2:] == ("--workers", "3")
    assert "--reload" not in supervisor.backend.command
    environment = supervisor.frontend.environment
    assert environment is not None
    assert environment["NODE_ENV"] == "production"
    assert environment["FLUXFAST_PRODUCTION_START"] == "1"
    assert environment["FLUXFAST_BACKEND_URL"] == "http://[::1]:8124"
    assert environment["APPLICATION_SECRET"] == "private"
    assert "NEXT_PUBLIC_FLUXFAST_BACKEND_URL" not in environment
    assert addresses == ["http://[::1]:8124/_fluxfast/readyz", ("127.0.0.1", 3100)]
    assert supervisor.backend_ready() and supervisor.frontend_ready()
    assert "React/Vite ready" in capsys.readouterr().out


@pytest.mark.parametrize("missing", ["manifest", "renderer", "both"])
def test_react_requires_its_own_completed_build_never_a_next_build(
    tmp_path: Path, missing: str
):
    root = built(frontend(tmp_path / "frontend"))
    (root / ".next").mkdir()
    (root / ".next" / "BUILD_ID").touch()
    if missing in {"manifest", "both"}:
        (root / "dist/fluxfast/host.json").unlink()
    if missing in {"renderer", "both"}:
        (root / "dist/fluxfast/server/renderer.mjs").unlink()
    assert not frontend_build_exists(root)
    with pytest.raises(ProductionBuildMissingError, match="React/Vite.*fluxfast build"):
        create_production_supervisor(ProductionConfig(app="backend:app", frontend=root))
    assert main(["start", "backend:app", "--frontend", str(root)]) == 5


@pytest.mark.parametrize(
    "declarations", [{"@fluxfast/vite": "*", "@fluxfast/next": "*"}, []]
)
def test_invalid_or_ambiguous_runtime_selection_fails_before_process_execution(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, declarations: object
):
    root = built(frontend(tmp_path / "frontend"))
    manifest = json.loads((root / "package.json").read_text())
    manifest["dependencies"] = declarations
    (root / "package.json").write_text(json.dumps(manifest))
    monkeypatch.setattr("shutil.which", lambda name: "/tools/" + name)
    monkeypatch.setattr(
        "subprocess.Popen", lambda *args, **kwargs: pytest.fail("must not spawn")
    )
    with pytest.raises(ProductionFrontendError):
        create_production_supervisor(ProductionConfig(app="backend:app", frontend=root))
    assert main(["dev", "backend:app", "--frontend", str(root)]) == 1
    monkeypatch.setattr(
        "fluxfast.production.diagnostics._node_version", lambda: (24, 19, 0)
    )
    app = FastAPI()
    FluxFast(app)
    monkeypatch.setattr(
        "fluxfast.production.diagnostics._load_application", lambda _: app
    )
    monkeypatch.setattr(
        "fluxfast.production.diagnostics._frontend_check",
        lambda *args: pytest.fail("must not choose a host"),
    )
    report = diagnose_production(ProductionConfig(app="backend:app", frontend=root))
    assert not report.valid
    assert "Frontend adapter could not be selected" in render_production_report(report)


@pytest.mark.parametrize(
    ("version", "valid"),
    [
        (None, False),
        ((22, 11, 0), False),
        ((22, 12, 0), True),
        ((24, 0, 0), True),
        ((20, 19, 0), False),
    ],
)
def test_react_doctor_checks_react_packages_and_vite_node_floor_without_next(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    version: tuple[int, int, int] | None,
    valid: bool,
):
    root = built(frontend(tmp_path / "frontend"))
    for name in ("core", "react", "vite"):
        package = root / "node_modules" / "@fluxfast" / name
        package.mkdir(parents=True)
        (package / "package.json").write_text(json.dumps({"version": __version__}))
    app = FastAPI()
    FluxFast(app)
    monkeypatch.setattr(
        "fluxfast.production.diagnostics._node_version", lambda: version
    )
    monkeypatch.setattr(
        "fluxfast.production.diagnostics._load_application", lambda _: app
    )
    monkeypatch.setattr(
        "fluxfast.production.diagnostics._frontend_check", lambda *args: True
    )
    report = diagnose_production(ProductionConfig(app="backend:app", frontend=root))
    rendered = render_production_report(report)
    assert report.valid is valid
    assert "Next.js" not in rendered
    assert "React/Vite adapter is initialized" in rendered
    assert "FluxFast packages synchronized" in rendered
    if not valid:
        assert "22.12+ or 24" in rendered


@pytest.mark.parametrize("topology", ["npm-nested", "pnpm", "workspace"])
def test_react_dependency_versions_resolve_without_a_next_package(
    tmp_path: Path, topology: str
):
    root = frontend(tmp_path / "workspace" / "frontend")
    if topology == "npm-nested":
        package_root = root / "node_modules/@fluxfast/vite/node_modules/@fluxfast"
        (root / "node_modules/@fluxfast/vite").mkdir(parents=True)
    elif topology == "pnpm":
        real_host = root / "node_modules/.pnpm/host/node_modules/@fluxfast/vite"
        real_host.mkdir(parents=True)
        (root / "node_modules/@fluxfast").mkdir()
        (root / "node_modules/@fluxfast/vite").symlink_to(
            real_host, target_is_directory=True
        )
        package_root = real_host.parent
    else:
        package_root = root.parent / "node_modules/@fluxfast"
    for package in ("core", "react"):
        location = package_root / package
        location.mkdir(parents=True)
        (location / "package.json").write_text('{"version":"1.2.0"}')
        assert _package_version(root, "@fluxfast/" + package) == "1.2.0"


def test_react_version_discovery_prefers_its_local_host_over_next_and_ancestors(
    tmp_path: Path,
):
    root = frontend(tmp_path / "workspace" / "frontend")
    for directory, version in (
        (root / "node_modules/@fluxfast/vite/node_modules/@fluxfast/core", "1.2.0"),
        (root / "node_modules/@fluxfast/next/node_modules/@fluxfast/core", "1.0.1"),
        (root.parent / "node_modules/@fluxfast/core", "1.1.0"),
    ):
        directory.mkdir(parents=True)
        (directory / "package.json").write_text(json.dumps({"version": version}))
    assert _package_version(root, "@fluxfast/core") == "1.2.0"


def test_react_dev_preserves_ordered_start_and_sibling_cleanup(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    root = frontend(tmp_path / "frontend")
    monkeypatch.setattr("shutil.which", lambda name: "/tools/" + name)
    created, stopped, events = [], [], []

    class Process:
        def __init__(self, command, **kwargs):
            self.command, self.kwargs = command, kwargs
            created.append(self)
            events.append("backend" if len(created) == 1 else "frontend")

        def poll(self):
            return 7 if len(created) == 2 and self is created[1] else None

    monkeypatch.setattr("fluxfast.cli.subprocess.Popen", Process)
    monkeypatch.setattr("fluxfast.cli._available_port", lambda _: 43123)
    monkeypatch.setattr(
        "fluxfast.cli._wait_for_backend", lambda *args: events.append("backend-ready")
    )
    monkeypatch.setattr("fluxfast.cli._stop_process", stopped.append)
    assert run_dev(DevConfig(app="backend:app", frontend=root)) == 7
    assert events == ["backend", "backend-ready", "frontend"]
    assert created[1].command[:3] == ["/tools/npm", "run", "fluxfast:dev"]
    assert created[1].kwargs["env"]["FLUXFAST_BACKEND_URL"] == "http://127.0.0.1:43123"
    assert stopped == [created[1], created[0]]
