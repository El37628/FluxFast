"""Machine-verifiable v0.8.1 top-level public API baseline."""

import inspect
import json
from pathlib import Path
from typing import get_origin

import fluxfast

_BASELINE_PATH = (
    Path(__file__).resolve().parents[3]
    / "tests"
    / "fixtures"
    / "public-api-v0.8.1.json"
)


def _baseline() -> dict[str, object]:
    return json.loads(_BASELINE_PATH.read_text(encoding="utf8"))["python"]


def _export_kind(name: str) -> str:
    value = getattr(fluxfast, name)
    if inspect.isclass(value):
        return "classes"
    if inspect.isfunction(value):
        return "functions"
    if get_origin(value) is not None:
        return "typeAliases"
    if isinstance(value, (bytes, float, int, str, tuple)):
        return "constants"
    return "objects"


def _resolve_public_target(path: str) -> object:
    target: object = fluxfast
    for segment in path.split("."):
        target = getattr(target, segment)
    return target


def test_top_level_public_names_and_kinds_match_v081() -> None:
    """Every supported name remains importable from its public package path."""

    expected = _baseline()["exports"]
    expected_names = sorted(
        name for names in expected.values() for name in names
    )

    assert len(fluxfast.__all__) == len(set(fluxfast.__all__))
    assert sorted(fluxfast.__all__) == expected_names
    assert {
        kind: sorted(name for name in fluxfast.__all__ if _export_kind(name) == kind)
        for kind in expected
    } == expected
    assert all(hasattr(fluxfast, name) for name in expected_names)


def test_important_public_signatures_match_v081() -> None:
    """Lock the call shapes most likely to be used by applications."""

    expected = _baseline()["signatures"]
    actual = {
        path: str(inspect.signature(_resolve_public_target(path)))
        for path in expected
    }
    assert actual == expected
