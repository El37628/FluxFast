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
