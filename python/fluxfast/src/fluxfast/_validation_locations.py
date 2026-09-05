"""Internal normalization for FastAPI/Pydantic validation locations."""

import json
import re

_IDENTIFIER = re.compile(r"^[A-Za-z_$][A-Za-z0-9_$]*$")
_TRANSPORT_PREFIXES = frozenset({"body", "query", "path", "header", "cookie"})
_ROOT_LOCATION = "general"
_SURROGATE = re.compile(r"[\ud800-\udfff]")
_MISSING = object()


def _quote_segment(segment: str) -> str:
    """Return JSON string notation without leaving invalid Unicode in the key."""

    quoted = json.dumps(segment, ensure_ascii=False, separators=(",", ":"))
    return _SURROGATE.sub(lambda match: f"\\u{ord(match.group()):04x}", quoted)


def _body_path_segments(
    segments: tuple[object, ...] | list[object],
    body: object,
    *,
    error_type: object,
    error_input: object,
) -> list[object]:
    """Remove Pydantic union-choice labels by following the submitted body."""

    selected: list[object] = []
    current = body
    for index, segment in enumerate(segments):
        last = index == len(segments) - 1
        if type(current) is dict:
            if type(segment) is str and segment in current:
                selected.append(segment)
                current = current[segment]
            elif last and (error_type == "missing" or error_input is not current):
                selected.append(segment)
                current = _MISSING
            # An absent non-final segment, or a final segment identifying the
            # current error input, is a Pydantic union-choice label.
        elif type(current) is list and type(segment) is int:
            selected.append(segment)
            current = current[segment] if 0 <= segment < len(current) else _MISSING
        elif current is _MISSING:
            selected.append(segment)
        # A segment below a submitted scalar is a Pydantic union-choice label.

    return selected


def _normalize_validation_location(
    location: object,
    *,
    body: object = _MISSING,
    error_type: object = None,
    error_input: object = _MISSING,
) -> str:
    """Render a FastAPI location as the canonical frontend field identity."""

    if error_type == "json_invalid":
        return _ROOT_LOCATION
    if type(location) not in (list, tuple) or not location:
        return _ROOT_LOCATION

    first = location[0]
    start = 1 if type(first) is str and first in _TRANSPORT_PREFIXES else 0
    segments = location[start:]
    if first == "body" and type(body) in (dict, list):
        segments = _body_path_segments(
            segments,
            body,
            error_type=error_type,
            error_input=error_input,
        )
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
