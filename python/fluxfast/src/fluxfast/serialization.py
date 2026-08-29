"""Pydantic-compatible JSON conversion and stable resource hashing."""

import hashlib
import json
from typing import Any

from pydantic import TypeAdapter

_JSON_ADAPTER = TypeAdapter(Any)


def to_jsonable(value: Any) -> Any:
    """Convert supported Python values to the representation sent on the wire."""
    return _JSON_ADAPTER.dump_python(value, mode="json")


def canonical_json(value: Any) -> str:
    """Serialize the wire representation to deterministic canonical JSON."""
    return json.dumps(
        to_jsonable(value),
        sort_keys=True,
        ensure_ascii=False,
        separators=(",", ":"),
        allow_nan=False,
    )


def compute_version(value: Any) -> str:
    """Compute a stable 128-bit BLAKE2b hash of the wire representation."""
    json_bytes = canonical_json(value).encode("utf-8")
    return hashlib.blake2b(json_bytes, digest_size=16).hexdigest()
