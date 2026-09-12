"""Freeze the non-exported Python contract surfaces adopted from v0.9.0."""

from __future__ import annotations

import argparse
import json
from dataclasses import asdict
from pathlib import Path
from typing import Any

from fluxfast.capabilities import (
    CAPABILITY_DEFERRED_RESOURCES,
    CAPABILITY_LIVE_RESOURCES,
)
from fluxfast.cli import _parser
from fluxfast.headers import (
    HEADER_CAPABILITIES,
    HEADER_CLIENT_ID,
    HEADER_FLUXFAST,
    HEADER_KNOWN,
    HEADER_LIVE,
    HEADER_LIVE_KEYS,
    HEADER_ONLY,
    HEADER_PROTOCOL,
    HEADER_VISIT,
)
from fluxfast.live.events import LIVE_EVENT_NAME
from fluxfast.production.config import resolve_production_config
from fluxfast.protocol import PROTOCOL_MEDIA_TYPE, PROTOCOL_VERSION
from fluxfast.schema_manifest import (
    SCHEMA_MANIFEST_V1,
    SCHEMA_MANIFEST_V2,
    SCHEMA_MANIFEST_VERSION,
    SCHEMA_MANIFEST_VERSION_2,
)

_BASELINE_PATH = (
    Path(__file__).resolve().parents[3]
    / "tests"
    / "fixtures"
    / "public-api-v0.9.0.json"
)


def _contracts() -> dict[str, Any]:
    return json.loads(_BASELINE_PATH.read_text(encoding="utf8"))["contracts"]


def _normalize_default(value: object) -> object:
    if isinstance(value, Path):
        return "<cwd>"
    return value


def _python_cli_surface() -> dict[str, object]:
    parser = _parser()
    subparsers = next(
        action
        for action in parser._actions
        if isinstance(action, argparse._SubParsersAction)
    )
    commands: dict[str, object] = {}
    for name, command_parser in sorted(subparsers.choices.items()):
        options: list[str] = []
        positionals: list[str] = []
        required_options: list[str] = []
        defaults: dict[str, object] = {}
        for action in command_parser._actions:
            if action.dest == "help":
                continue
            if not action.option_strings:
                positionals.append(action.dest)
                continue
            option = next(
                candidate
                for candidate in action.option_strings
                if candidate.startswith("--")
            )
            options.append(option)
            defaults[option] = _normalize_default(action.default)
            if action.required:
                required_options.append(option)
        commands[name] = {
            "defaults": dict(sorted(defaults.items())),
            "options": sorted(options),
            "positionals": positionals,
            "requiredOptions": sorted(required_options),
        }
    return {"commands": commands}


def test_python_cli_surface_matches_v09_promotion_baseline() -> None:
    assert _python_cli_surface() == _contracts()["pythonCli"]


def test_production_defaults_match_v09_promotion_baseline(tmp_path: Path) -> None:
    frontend = tmp_path / "frontend"
    frontend.mkdir()
    config = asdict(
        resolve_production_config(
            "backend.main:app",
            frontend,
            environment={},
        )
    )
    del config["app"]
    del config["frontend"]

    assert config == _contracts()["productionDefaults"]


def test_protocol_constants_match_v09_promotion_baseline() -> None:
    expected = _contracts()["protocol"]
    request_headers = sorted(
        [
            "Accept",
            "Content-Type",
            HEADER_CAPABILITIES,
            HEADER_CLIENT_ID,
            HEADER_FLUXFAST,
            HEADER_KNOWN,
            HEADER_LIVE,
            HEADER_LIVE_KEYS,
            HEADER_ONLY,
            HEADER_PROTOCOL,
            HEADER_VISIT,
        ]
    )

    assert expected == {
        "capabilities": [
            CAPABILITY_DEFERRED_RESOURCES,
            CAPABILITY_LIVE_RESOURCES,
        ],
        "liveEventName": LIVE_EVENT_NAME,
        "mediaType": PROTOCOL_MEDIA_TYPE,
        "requestHeaders": request_headers,
        "version": PROTOCOL_VERSION,
    }


def test_schema_constants_match_v09_promotion_baseline() -> None:
    assert _contracts()["schema"] == {
        "javascriptConstants": {
            "FLUXFAST_SCHEMA_MANIFEST_V1": SCHEMA_MANIFEST_V1,
            "FLUXFAST_SCHEMA_MANIFEST_V2": SCHEMA_MANIFEST_V2,
            "FLUXFAST_SCHEMA_MANIFEST_VERSION": SCHEMA_MANIFEST_V1,
        },
        "produced": SCHEMA_MANIFEST_V2,
        "pythonConstants": {
            "SCHEMA_MANIFEST_V1": SCHEMA_MANIFEST_V1,
            "SCHEMA_MANIFEST_V2": SCHEMA_MANIFEST_V2,
            "SCHEMA_MANIFEST_VERSION": SCHEMA_MANIFEST_VERSION,
            "SCHEMA_MANIFEST_VERSION_2": SCHEMA_MANIFEST_VERSION_2,
        },
        "readable": [SCHEMA_MANIFEST_V1, SCHEMA_MANIFEST_V2],
    }
