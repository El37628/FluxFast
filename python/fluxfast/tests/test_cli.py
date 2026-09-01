"""Tests for the one-command development supervisor."""

import json
from pathlib import Path
from subprocess import CompletedProcess

import pytest
from fastapi import Depends, FastAPI
from pydantic import BaseModel

from fluxfast import FluxFast, Page
from fluxfast.cli import (
    DevConfig,
    DevServerError,
    SchemaCommandError,
    TypeGenerationError,
    _frontend_command,
    _load_schema_app,
    _type_generation_command,
    main,
    run_dev,
    run_schema,
    run_types,
)


class Room(BaseModel):
    id: int


def _schema_app() -> FastAPI:
    app = FastAPI()
    flux = FluxFast(app)
    flux.define_resource("rooms", list[Room])
    return app


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


@pytest.mark.parametrize(
    ("lockfile", "expected_prefix"),
    [
        ("package-lock.json", ["npm", "exec", "--no", "--"]),
        ("pnpm-lock.yaml", ["pnpm", "exec"]),
        ("yarn.lock", ["yarn", "exec"]),
        ("bun.lock", ["bun", "x", "--no-install"]),
    ],
)
def test_type_generation_command_uses_local_frontend_package_manager(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    lockfile: str,
    expected_prefix: list[str],
) -> None:
    (tmp_path / lockfile).touch()
    schema_file = tmp_path / "schema.json"
    monkeypatch.setattr("fluxfast.cli.shutil.which", lambda name: f"/bin/{name}")

    assert _type_generation_command(tmp_path, schema_file, check=True) == [
        *expected_prefix,
        "fluxfast",
        "generate",
        "--schema-file",
        str(schema_file),
        "--check",
    ]


def test_type_generation_command_reports_missing_manager(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    (tmp_path / "pnpm-lock.yaml").touch()
    monkeypatch.setattr("fluxfast.cli.shutil.which", lambda _name: None)

    with pytest.raises(TypeGenerationError, match="Could not find 'pnpm'"):
        _type_generation_command(
            tmp_path,
            tmp_path / "schema.json",
            check=False,
        )


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


def test_schema_command_writes_deterministic_manifest_to_stdout(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    app = _schema_app()
    monkeypatch.setattr("fluxfast.cli._load_schema_app", lambda _app_import: app)

    assert run_schema("backend:app") == 0
    first = capsys.readouterr().out
    assert run_schema("backend:app") == 0
    second = capsys.readouterr().out

    assert first == second
    assert first.endswith("\n")
    manifest = json.loads(first)
    assert manifest["schema"] == "fluxfast-schema/1"
    assert manifest["resources"]["rooms"]["schema"]["type"] == "array"


def test_schema_command_writes_output_and_check_detects_drift_without_modifying_file(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    app = _schema_app()
    monkeypatch.setattr("fluxfast.cli._load_schema_app", lambda _app_import: app)
    output = tmp_path / "frontend" / "src" / ".fluxfast" / "schema.generated.json"

    assert run_schema("backend:app", output=output) == 0
    generated = output.read_bytes()
    assert generated.endswith(b"\n")
    assert run_schema("backend:app", output=output, check=True) == 0

    output.write_bytes(b'{"stale":true}\n')
    stale = output.read_bytes()
    assert run_schema("backend:app", output=output, check=True) == 1
    assert output.read_bytes() == stale


def test_schema_check_missing_output_does_not_create_anything(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    app = _schema_app()
    monkeypatch.setattr("fluxfast.cli._load_schema_app", lambda _app_import: app)
    output = tmp_path / "missing" / "schema.generated.json"

    assert run_schema("backend:app", output=output, check=True) == 1
    assert not output.exists()
    assert not output.parent.exists()


def test_schema_check_requires_output(monkeypatch: pytest.MonkeyPatch) -> None:
    app = _schema_app()
    monkeypatch.setattr("fluxfast.cli._load_schema_app", lambda _app_import: app)

    with pytest.raises(SchemaCommandError, match="--check requires --output"):
        run_schema("backend:app", check=True)


def test_schema_app_import_reports_invalid_targets(monkeypatch: pytest.MonkeyPatch) -> None:
    with pytest.raises(SchemaCommandError, match="module:attribute"):
        _load_schema_app("backend")

    monkeypatch.setattr("fluxfast.cli.importlib.import_module", lambda _name: object())
    with pytest.raises(SchemaCommandError, match="does not resolve to an attribute"):
        _load_schema_app("backend:app")


def test_schema_command_does_not_execute_handlers_or_dependencies(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    app = FastAPI()
    flux = FluxFast(app)
    flux.define_resource("rooms", list[Room])
    calls = {"page": 0, "dependency": 0, "mutation": 0}

    def dependency() -> str:
        calls["dependency"] += 1
        return "private-user"

    @flux.page("/rooms")
    async def rooms_page(_user: str = Depends(dependency)) -> Page:
        calls["page"] += 1
        return Page(component="rooms/index")

    @flux.mutation("/rooms", methods=["POST"])
    async def create_room(_user: str = Depends(dependency)) -> dict[str, bool]:
        calls["mutation"] += 1
        return {"ok": True}

    monkeypatch.setattr("fluxfast.cli._load_schema_app", lambda _app_import: app)

    assert run_schema("backend:app") == 0
    assert calls == {"page": 0, "dependency": 0, "mutation": 0}


def test_types_command_passes_current_schema_to_frontend_cli(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    frontend = tmp_path / "frontend"
    frontend.mkdir()
    (frontend / "package.json").write_text("{}\n", encoding="utf8")
    app = _schema_app()
    observed: dict[str, object] = {}

    monkeypatch.setattr("fluxfast.cli._load_schema_app", lambda _app_import: app)

    def command(
        received_frontend: Path,
        schema_file: Path,
        *,
        check: bool,
    ) -> list[str]:
        observed["frontend"] = received_frontend
        observed["schema_file"] = schema_file
        observed["check"] = check
        return ["frontend-cli", str(schema_file)]

    def run(
        command: list[str],
        *,
        cwd: Path,
        check: bool,
    ) -> CompletedProcess[str]:
        schema_file = Path(command[-1])
        payload = json.loads(schema_file.read_text(encoding="utf8"))
        observed["payload"] = payload
        observed["cwd"] = cwd
        observed["subprocess_check"] = check
        return CompletedProcess(command, 7)

    monkeypatch.setattr("fluxfast.cli._type_generation_command", command)
    monkeypatch.setattr("fluxfast.cli.subprocess.run", run)

    assert run_types("backend:app", frontend=frontend, check=True) == 7
    assert observed["frontend"] == frontend.resolve()
    assert observed["cwd"] == frontend.resolve()
    assert observed["check"] is True
    assert observed["subprocess_check"] is False
    assert observed["payload"]["schema"] == "fluxfast-schema/1"  # type: ignore[index]
    assert not Path(observed["schema_file"]).exists()  # type: ignore[arg-type]


def test_types_parser_forwards_frontend_and_check(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    observed: dict[str, object] = {}

    def run(app: str, *, frontend: Path, check: bool) -> int:
        observed.update(app=app, frontend=frontend, check=check)
        return 0

    monkeypatch.setattr("fluxfast.cli.run_types", run)

    assert main(
        ["types", "backend.main:app", "--frontend", "web", "--check"]
    ) == 0
    assert observed == {
        "app": "backend.main:app",
        "frontend": Path("web"),
        "check": True,
    }
