"""Regression tests for imports from installed FluxFast console scripts."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

from fluxfast.application_import import (
    ApplicationImportError,
    load_fastapi_application,
)


def test_application_import_temporarily_adds_console_working_directory(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    module_name = "fluxfast_console_fixture"
    (tmp_path / f"{module_name}.py").write_text(
        "from fastapi import FastAPI\napp = FastAPI()\n",
        encoding="utf8",
    )
    original_path = list(sys.path)
    monkeypatch.delitem(sys.modules, module_name, raising=False)

    application = load_fastapi_application(f"{module_name}:app", cwd=tmp_path)

    assert application.title == "FastAPI"
    assert sys.path == original_path


def test_application_import_reports_invalid_targets_without_invoking_them(
    tmp_path: Path,
) -> None:
    (tmp_path / "invalid_fixture.py").write_text(
        "def app():\n    raise RuntimeError('must not execute')\n",
        encoding="utf8",
    )

    with pytest.raises(ApplicationImportError, match="must resolve to a FastAPI"):
        load_fastapi_application("invalid_fixture:app", cwd=tmp_path)


def test_application_import_does_not_expose_import_exception_secrets(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    sentinel = "postgres://admin:do-not-log@database.internal/app"
    monkeypatch.setattr(
        "fluxfast.application_import.importlib.import_module",
        lambda _module: (_ for _ in ()).throw(RuntimeError(sentinel)),
    )

    with pytest.raises(ApplicationImportError) as captured:
        load_fastapi_application("backend:app")

    assert str(captured.value) == "Could not import application module 'backend'"
    assert "do-not-log" not in str(captured.value)
    assert captured.value.__cause__ is not None
