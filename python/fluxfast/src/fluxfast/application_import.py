"""Safe FastAPI application imports for installed FluxFast CLI commands."""

from __future__ import annotations

import importlib
import sys
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

from fastapi import FastAPI


class ApplicationImportError(ValueError):
    """Raised when a module:attribute import does not resolve to FastAPI."""


@contextmanager
def _project_import_path(root: Path) -> Iterator[None]:
    """Temporarily make a console command's working directory importable."""

    value = str(root.resolve())
    inserted = value not in sys.path
    if inserted:
        sys.path.insert(0, value)
    try:
        yield
    finally:
        if inserted:
            try:
                sys.path.remove(value)
            except ValueError:
                pass


def load_fastapi_application(
    app_import: str,
    *,
    cwd: Path | None = None,
) -> FastAPI:
    """Resolve a FastAPI application without invoking routes or dependencies."""

    module_name, separator, attribute_path = app_import.partition(":")
    if not separator or not module_name or not attribute_path:
        raise ApplicationImportError(
            "Application import must use module:attribute format, for example backend:app"
        )

    try:
        with _project_import_path(cwd or Path.cwd()):
            value: object = importlib.import_module(module_name)
    except Exception as error:
        raise ApplicationImportError(
            f"Could not import application module '{module_name}'"
        ) from error

    try:
        for attribute in attribute_path.split("."):
            value = getattr(value, attribute)
    except AttributeError as error:
        raise ApplicationImportError(
            f"Application import '{app_import}' does not resolve to an attribute"
        ) from error

    if not isinstance(value, FastAPI):
        raise ApplicationImportError(
            f"Application import '{app_import}' must resolve to a FastAPI application"
        )
    return value
