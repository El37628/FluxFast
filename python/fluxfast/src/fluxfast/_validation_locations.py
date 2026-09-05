"""Internal normalization for FastAPI/Pydantic validation locations."""

import json
import re

_IDENTIFIER = re.compile(r"^[A-Za-z_$][A-Za-z0-9_$]*$")
_TRANSPORT_PREFIXES = frozenset({"body", "query", "path", "header", "cookie"})
_ROOT_LOCATION = "general"
_SURROGATE = re.compile(r"[\ud800-\udfff]")


def _quote_segment(segment: str) -> str:
    """Return JSON string notation without leaving invalid Unicode in the key."""

    quoted = json.dumps(segment, ensure_ascii=False, separators=(",", ":"))
    return _SURROGATE.sub(lambda match: f"\\u{ord(match.group()):04x}", quoted)


def _normalize_validation_location(location: object) -> str:
    """Render a FastAPI location as the canonical frontend field identity."""

    if type(location) not in (list, tuple) or not location:
        return _ROOT_LOCATION

    first = location[0]
    start = 1 if type(first) is str and first in _TRANSPORT_PREFIXES else 0
    segments = location[start:]
    if not segments:
        return _ROOT_LOCATION

    result: list[str] = []
    for index, segment in enumerate(segments):
        if type(segment) is int:
            result.append(f"[{segment}]")
        elif type(segment) is str:
            if _IDENTIFIER.fullmatch(segment) and not (index == 0 and segment == "$"):
                result.append(segment if index == 0 else f".{segment}")
            else:
                result.append(f"[{_quote_segment(segment)}]")
        else:
            # Pydantic locations contain only strings and integers. Falling back
            # avoids invoking arbitrary __str__ or __repr__ implementations.
            return _ROOT_LOCATION

    return "".join(result)
