"""Adapter detection and installed-only Python-to-JavaScript generation."""

import json
from pathlib import Path
from subprocess import CompletedProcess, TimeoutExpired

import pytest
from fastapi import FastAPI

from fluxfast import FluxFast
from fluxfast.cli import (
    TypeGenerationError,
    _detect_frontend_adapter,
    _parser,
    _type_generation_command,
    main,
    run_types,
)


def manifest(root: Path, value: object) -> None:
    (root / "package.json").write_text(json.dumps(value), encoding="utf8")


def binary(root: Path, name: str) -> Path:
    destination = root / "node_modules" / ".bin" / name
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text("#!/usr/bin/env node\n", encoding="utf8")
    destination.chmod(0o755)
    return destination


@pytest.mark.parametrize("section", ["dependencies", "devDependencies"])
@pytest.mark.parametrize(
    ("package", "target"), [("@fluxfast/next", "next"), ("@fluxfast/vite", "react")]
)
def test_adapter_is_detected_only_from_fluxfast_packages(
    tmp_path: Path, section: str, package: str, target: str
):
    manifest(tmp_path, {section: {package: "^1.1.0"}})
    assert _detect_frontend_adapter(tmp_path).value == target


@pytest.mark.parametrize(
    "package",
    ["next", "react", "vite", "@fluxfast/core", "@fluxfast/react"],
)
def test_unrelated_or_future_packages_do_not_activate_an_adapter(
    tmp_path: Path, package: str
):
    manifest(tmp_path, {"dependencies": {package: "*"}})
    with pytest.raises(TypeGenerationError, match="--adapter next"):
        _detect_frontend_adapter(tmp_path)


def test_explicit_adapter_allows_a_codegen_only_project(tmp_path: Path):
    manifest(tmp_path, {"devDependencies": {"@fluxfast/codegen": "*"}})
    assert _detect_frontend_adapter(tmp_path, "next").value == "next"


@pytest.mark.parametrize("adapter", ["svelte", "NEXT", "__proto__", ""])
def test_unknown_override_fails_closed(tmp_path: Path, adapter: str):
    manifest(tmp_path, {"dependencies": {"@fluxfast/next": "*"}})
    with pytest.raises(TypeGenerationError, match="Unsupported FluxFast adapter"):
        _detect_frontend_adapter(tmp_path, adapter)


@pytest.mark.parametrize(
    "value",
    [
        None,
        [],
        "invalid",
        {"dependencies": []},
        {"devDependencies": "next"},
        {"dependencies": {"@fluxfast/next": None}},
    ],
)
def test_malformed_metadata_is_actionable_and_read_only(tmp_path: Path, value: object):
    manifest(tmp_path, value)
    before = (tmp_path / "package.json").read_bytes()
    with pytest.raises(TypeGenerationError, match="package.json"):
        _detect_frontend_adapter(tmp_path)
    assert (tmp_path / "package.json").read_bytes() == before
    assert list(tmp_path.iterdir()) == [tmp_path / "package.json"]


def test_invalid_json_and_missing_metadata_report_tooling_errors(tmp_path: Path):
    with pytest.raises(TypeGenerationError, match="package.json"):
        _detect_frontend_adapter(tmp_path)
    (tmp_path / "package.json").write_text("[", encoding="utf8")
    with pytest.raises(TypeGenerationError, match="package.json"):
        _detect_frontend_adapter(tmp_path)


@pytest.mark.parametrize(
    ("lock", "prefix"),
    [
        ("package-lock.json", ["npm", "exec", "--no", "--"]),
        ("pnpm-lock.yaml", ["pnpm", "exec"]),
        ("yarn.lock", ["yarn", "exec"]),
        ("bun.lock", ["bun", "x", "--no-install"]),
    ],
)
@pytest.mark.parametrize("generic", [False, True])
@pytest.mark.parametrize("target", ["next", "react"])
def test_generator_prefers_local_codegen_and_keeps_legacy_fallback(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    lock: str,
    prefix: list[str],
    generic: bool,
    target: str,
):
    package = "@fluxfast/next" if target == "next" else "@fluxfast/vite"
    fallback = "fluxfast" if target == "next" else "fluxfast-vite"
    manifest(tmp_path, {"dependencies": {package: "^1.1.0"}})
    (tmp_path / lock).touch()
    binary(tmp_path, "fluxfast")
    binary(tmp_path, fallback)
    if generic:
        binary(tmp_path, "fluxfast-codegen")
    monkeypatch.setattr("fluxfast.cli.shutil.which", lambda name: f"/bin/{name}")
    expected = [*prefix, "fluxfast-codegen" if generic else fallback, "generate"]
    if generic:
        expected.extend(["--adapter", target])
    expected.extend(
        ["--schema-file", str(tmp_path / "schema with spaces.json"), "--check"]
    )
    assert (
        _type_generation_command(
            tmp_path, tmp_path / "schema with spaces.json", check=True
        )
        == expected
    )


def test_declaring_tooling_without_installing_it_never_uses_global_path(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    manifest(
        tmp_path, {"dependencies": {"@fluxfast/next": "*", "@fluxfast/codegen": "*"}}
    )
    monkeypatch.setattr("fluxfast.cli.shutil.which", lambda name: f"/global/{name}")
    with pytest.raises(
        TypeGenerationError, match="installed FluxFast JavaScript tooling"
    ):
        _type_generation_command(tmp_path, tmp_path / "schema.json", check=False)
    assert not (tmp_path / "node_modules").exists()


def test_workspace_hoisted_bin_is_found(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    frontend = tmp_path / "workspace" / "frontend"
    frontend.mkdir(parents=True)
    manifest(frontend, {"dependencies": {"@fluxfast/next": "*"}})
    binary(tmp_path, "fluxfast-codegen")
    monkeypatch.setattr("fluxfast.cli.shutil.which", lambda name: f"/bin/{name}")
    command = _type_generation_command(frontend, tmp_path / "schema.json", check=False)
    assert command[4:8] == ["fluxfast-codegen", "generate", "--adapter", "next"]
    assert "--check" not in command


@pytest.mark.parametrize("generic", [False, True])
@pytest.mark.parametrize("target", ["next", "react"])
def test_yarn_pnp_probes_only_installed_workspace_binaries(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, generic: bool, target: str
):
    package = "@fluxfast/next" if target == "next" else "@fluxfast/vite"
    fallback = "fluxfast" if target == "next" else "fluxfast-vite"
    manifest(
        tmp_path,
        {"dependencies": {package: "*"}, "packageManager": "yarn@4.0.0"},
    )
    (tmp_path / ".pnp.cjs").touch()
    monkeypatch.setattr("fluxfast.cli.shutil.which", lambda name: f"/bin/{name}")
    observed = []

    def probe(command, **kwargs):
        observed.append(command)
        assert kwargs == {
            "cwd": tmp_path,
            "check": False,
            "capture_output": True,
            "text": True,
            "encoding": "utf-8",
            "errors": "replace",
            "shell": False,
            "timeout": 10,
        }
        exists = command[-1] == ("fluxfast-codegen" if generic else fallback)
        return CompletedProcess(
            command,
            0 if exists else 1,
            stdout="/cache/tool.zip/package/bin.js\n" if exists else "",
            stderr="",
        )

    monkeypatch.setattr("fluxfast.cli.subprocess.run", probe)
    command = _type_generation_command(tmp_path, tmp_path / "schema.json", check=False)
    assert command[2] == ("fluxfast-codegen" if generic else fallback)
    assert observed == [["yarn", "bin", "fluxfast-codegen"]] + (
        [] if generic else [["yarn", "bin", fallback]]
    )


@pytest.mark.parametrize(
    "failure", [OSError("unavailable"), TimeoutExpired("yarn", 10)]
)
def test_yarn_probe_failures_are_actionable_without_installing_or_falling_back(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, failure: Exception
):
    manifest(
        tmp_path,
        {"dependencies": {"@fluxfast/next": "*"}, "packageManager": "yarn@4.0.0"},
    )
    (tmp_path / ".pnp.cjs").touch()
    monkeypatch.setattr("fluxfast.cli.shutil.which", lambda name: f"/bin/{name}")

    def probe(*args, **kwargs):
        raise failure

    monkeypatch.setattr("fluxfast.cli.subprocess.run", probe)
    with pytest.raises(
        TypeGenerationError,
        match="Could not inspect installed FluxFast tooling with Yarn",
    ):
        _type_generation_command(tmp_path, tmp_path / "schema.json", check=False)


@pytest.mark.parametrize("target", ["next", "react"])
def test_failing_generic_generator_is_not_retried_with_legacy(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    target: str,
):
    app = FastAPI()
    FluxFast(app)
    package = "@fluxfast/next" if target == "next" else "@fluxfast/vite"
    manifest(tmp_path, {"dependencies": {package: "*"}})
    binary(tmp_path, "fluxfast-codegen")
    binary(tmp_path, "fluxfast")
    binary(tmp_path, "fluxfast-vite")
    monkeypatch.setattr("fluxfast.cli.shutil.which", lambda name: f"/bin/{name}")
    monkeypatch.setattr("fluxfast.cli._load_schema_app", lambda _: app)
    observed = []

    def fail(command, **kwargs):
        observed.append(command)
        return CompletedProcess(
            command,
            7,
            stdout="unsupported validator warning\n",
            stderr="compiler failed\n",
        )

    monkeypatch.setattr("fluxfast.cli.subprocess.run", fail)
    assert run_types("backend:app", frontend=tmp_path, check=True) == 7
    assert len(observed) == 1
    assert observed[0][4] == "fluxfast-codegen"
    captured = capsys.readouterr()
    assert captured.out == "unsupported validator warning\n"
    assert captured.err == "compiler failed\n"


def test_unknown_project_fails_before_importing_the_backend(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
):
    manifest(tmp_path, {"dependencies": {"next": "*"}})
    monkeypatch.setattr(
        "fluxfast.cli._load_schema_app", lambda _: pytest.fail("backend was imported")
    )
    assert main(["types", "backend:app", "--frontend", str(tmp_path)]) == 1
    assert "--adapter next" in capsys.readouterr().err
    assert list(tmp_path.iterdir()) == [tmp_path / "package.json"]


def test_parser_exposes_supported_override_and_preserves_old_defaults():
    args = _parser().parse_args(["types", "backend:app"])
    assert args.adapter is None
    explicit = _parser().parse_args(["types", "backend:app", "--adapter", "next"])
    assert explicit.adapter == "next"
    react = _parser().parse_args(["types", "backend:app", "--adapter", "react"])
    assert react.adapter == "react"
    with pytest.raises(SystemExit) as error:
        _parser().parse_args(["types", "backend:app", "--adapter", "vite"])
    assert error.value.code == 2


@pytest.mark.parametrize("target", ["next", "react"])
def test_explicit_override_is_forwarded_to_run_types(
    monkeypatch: pytest.MonkeyPatch, target: str
):
    observed: dict[str, object] = {}
    monkeypatch.setattr(
        "fluxfast.cli.run_types",
        lambda app, **kwargs: observed.update(app=app, **kwargs) or 0,
    )
    assert (
        main(
            [
                "types",
                "backend:app",
                "--frontend",
                "frontend",
                "--adapter",
                target,
                "--check",
            ]
        )
        == 0
    )
    assert observed == {
        "app": "backend:app",
        "frontend": Path("frontend"),
        "check": True,
        "adapter": target,
    }


def test_direct_unknown_override_is_a_tooling_error(tmp_path: Path):
    manifest(tmp_path, {"dependencies": {"@fluxfast/next": "*"}})
    with pytest.raises(TypeGenerationError, match="Unsupported FluxFast adapter"):
        run_types("backend:app", frontend=tmp_path, adapter="vue")


def test_ambiguous_adapters_require_an_explicit_generation_target(tmp_path: Path):
    manifest(
        tmp_path,
        {
            "dependencies": {"@fluxfast/next": "*"},
            "devDependencies": {"@fluxfast/vite": "*"},
        },
    )
    before = (tmp_path / "package.json").read_bytes()
    with pytest.raises(
        TypeGenerationError, match="Multiple FluxFast frontend adapters"
    ):
        _detect_frontend_adapter(tmp_path)
    assert _detect_frontend_adapter(tmp_path, "next").value == "next"
    assert _detect_frontend_adapter(tmp_path, "react").value == "react"
    assert (tmp_path / "package.json").read_bytes() == before


def test_explicit_react_codegen_only_project_uses_the_shared_generator(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    manifest(tmp_path, {"devDependencies": {"@fluxfast/codegen": "*"}})
    binary(tmp_path, "fluxfast-codegen")
    monkeypatch.setattr("fluxfast.cli.shutil.which", lambda name: f"/bin/{name}")
    command = _type_generation_command(
        tmp_path, tmp_path / "schema.json", check=False, adapter="react"
    )
    assert command[4:8] == ["fluxfast-codegen", "generate", "--adapter", "react"]


def test_react_never_uses_a_legacy_next_binary_from_the_workspace_or_global_path(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    frontend = tmp_path / "frontend"
    frontend.mkdir()
    manifest(frontend, {"dependencies": {"@fluxfast/vite": "*"}})
    binary(tmp_path, "fluxfast")
    monkeypatch.setattr("fluxfast.cli.shutil.which", lambda name: f"/global/{name}")
    with pytest.raises(TypeGenerationError, match="fluxfast-vite generator"):
        _type_generation_command(frontend, tmp_path / "schema.json", check=False)
    assert not (frontend / "node_modules").exists()


def test_react_workspace_hoisted_host_binary_is_found(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    frontend = tmp_path / "workspace" / "frontend"
    frontend.mkdir(parents=True)
    manifest(frontend, {"devDependencies": {"@fluxfast/vite": "*"}})
    binary(tmp_path, "fluxfast-vite")
    monkeypatch.setattr("fluxfast.cli.shutil.which", lambda name: f"/bin/{name}")
    command = _type_generation_command(frontend, tmp_path / "schema.json", check=True)
    assert command[4:6] == ["fluxfast-vite", "generate"]
    assert "--adapter" not in command
    assert command[-1] == "--check"


def test_private_runtime_default_does_not_mask_ambiguous_or_invalid_metadata(
    tmp_path: Path,
):
    from fluxfast._frontend_adapter import (
        FrontendAdapter,
        FrontendAdapterError,
        detect_frontend_adapter,
    )

    manifest(tmp_path, {})
    assert (
        detect_frontend_adapter(tmp_path, legacy_default=FrontendAdapter.NEXT)
        is FrontendAdapter.NEXT
    )
    with pytest.raises(FrontendAdapterError, match="Could not detect"):
        detect_frontend_adapter(tmp_path)
    manifest(tmp_path, {"dependencies": {"@fluxfast/vite": "*", "@fluxfast/next": "*"}})
    with pytest.raises(FrontendAdapterError, match="Multiple"):
        detect_frontend_adapter(tmp_path, legacy_default=FrontendAdapter.NEXT)
    manifest(tmp_path, {"dependencies": []})
    with pytest.raises(FrontendAdapterError, match="non-empty version strings"):
        detect_frontend_adapter(tmp_path, legacy_default=FrontendAdapter.NEXT)
