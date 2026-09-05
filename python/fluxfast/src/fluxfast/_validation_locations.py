"""Internal normalization for FastAPI/Pydantic validation locations."""

import json
import re
from types import UnionType
from typing import Annotated, Literal, Union, get_args, get_origin

from pydantic import BaseModel

_IDENTIFIER = re.compile(r"^[A-Za-z_$][A-Za-z0-9_$]*$")
_TRANSPORT_PREFIXES = frozenset({"body", "query", "path", "header", "cookie"})
_ROOT_LOCATION = "general"
_SURROGATE = re.compile(r"[\ud800-\udfff]")
_PARAMETER_GROUPS = {
    "query": "query_params",
    "path": "path_params",
    "header": "header_params",
    "cookie": "cookie_params",
}


def _quote_segment(segment: str) -> str:
    """Return JSON string notation without leaving invalid Unicode in the key."""

    quoted = json.dumps(segment, ensure_ascii=False, separators=(",", ":"))
    return _SURROGATE.sub(lambda match: f"\\u{ord(match.group()):04x}", quoted)


def _field_annotation(field: object) -> object:
    field_info = getattr(field, "field_info", field)
    annotation = getattr(field_info, "annotation", None)
    if annotation is not None:
        if getattr(field_info, "discriminator", None) is not None:
            return Annotated[annotation, field_info]
        return annotation
    for attribute in ("annotation", "outer_type_", "type_"):
        annotation = getattr(field, attribute, None)
        if annotation is not None:
            return annotation
    return None


def _field_names(name: str, field: object) -> tuple[str, ...]:
    candidates = [name]
    for attribute in ("validation_alias", "alias"):
        candidate = getattr(field, attribute, None)
        if type(candidate) is str and candidate not in candidates:
            candidates.append(candidate)
    return tuple(candidates)


def _field_output_name(name: str, field: object) -> str:
    for attribute in ("validation_alias", "alias"):
        candidate = getattr(field, attribute, None)
        if type(candidate) is str:
            return candidate
    return name


def _unwrap_annotated(annotation: object) -> tuple[object, tuple[object, ...]]:
    metadata: list[object] = []
    while get_origin(annotation) is Annotated:
        arguments = get_args(annotation)
        annotation = arguments[0]
        metadata.extend(arguments[1:])
    return annotation, tuple(metadata)


def _union_label_candidates(
    annotation: object,
    metadata: tuple[object, ...],
    discriminator: str | None,
) -> tuple[object, ...]:
    labels: list[object] = []
    for item in metadata:
        tag = getattr(item, "tag", None)
        if type(tag) in (str, int) and tag not in labels:
            labels.append(tag)

    if isinstance(annotation, type) and issubclass(annotation, BaseModel):
        if discriminator is not None:
            for name, field in annotation.model_fields.items():
                if discriminator not in _field_names(name, field):
                    continue
                field_annotation, _ = _unwrap_annotated(_field_annotation(field))
                if get_origin(field_annotation) is Literal:
                    for value in get_args(field_annotation):
                        if type(value) in (str, int) and value not in labels:
                            labels.append(value)
        if annotation.__name__ not in labels:
            labels.append(annotation.__name__)
    elif isinstance(annotation, type) and annotation.__name__ not in labels:
        labels.append(annotation.__name__)

    return tuple(labels)


def _same_location_segment(left: object, right: object) -> bool:
    return type(left) is type(right) and type(left) in (str, int) and left == right


def _resolve_annotation_path(
    annotation: object,
    segments: tuple[object, ...] | list[object],
) -> list[object] | None:
    """Resolve Pydantic locations against declarations, omitting union labels."""

    annotation, metadata = _unwrap_annotated(annotation)
    if not segments:
        return []

    origin = get_origin(annotation)
    if origin in (Union, UnionType):
        choices = [choice for choice in get_args(annotation) if choice is not type(None)]
        if len(choices) == 1:
            return _resolve_annotation_path(choices[0], segments)

        discriminator = None
        for item in metadata:
            candidate = getattr(item, "discriminator", None)
            if type(candidate) is str:
                discriminator = candidate
                break

        label = segments[0]
        remaining = segments[1:]
        for choice in choices:
            choice_annotation, choice_metadata = _unwrap_annotated(choice)
            labels = _union_label_candidates(
                choice_annotation,
                choice_metadata,
                discriminator,
            )
            if not any(_same_location_segment(label, candidate) for candidate in labels):
                continue
            resolved = _resolve_annotation_path(choice, remaining)
            return resolved if resolved is not None else list(remaining)

        resolutions: list[list[object]] = []
        for choice in choices:
            resolved = _resolve_annotation_path(choice, remaining)
            if resolved is not None and resolved not in resolutions:
                resolutions.append(resolved)
        if len(resolutions) == 1:
            return resolutions[0]
        return list(remaining)

    if isinstance(annotation, type) and issubclass(annotation, BaseModel):
        if getattr(annotation, "__pydantic_root_model__", False):
            root_field = annotation.model_fields.get("root")
            if root_field is None:
                return None
            resolved = _resolve_annotation_path(_field_annotation(root_field), segments)
            return resolved if resolved is not None else list(segments)

        segment = segments[0]
        if type(segment) is not str:
            return None
        for name, field in annotation.model_fields.items():
            if segment not in _field_names(name, field):
                continue
            remaining = segments[1:]
            resolved = _resolve_annotation_path(_field_annotation(field), remaining)
            tail = resolved if resolved is not None else list(remaining)
            return [_field_output_name(name, field), *tail]
        return None

    if origin in (list, set, frozenset):
        segment = segments[0]
        if type(segment) is not int:
            return None
        remaining = segments[1:]
        item_annotation = get_args(annotation)[0] if get_args(annotation) else None
        resolved = _resolve_annotation_path(item_annotation, remaining)
        tail = resolved if resolved is not None else list(remaining)
        return [segment, *tail]

    if origin is tuple:
        segment = segments[0]
        if type(segment) is not int:
            return None
        remaining = segments[1:]
        arguments = get_args(annotation)
        item_annotation = (
            arguments[0]
            if len(arguments) == 2 and arguments[1] is Ellipsis
            else arguments[segment]
            if 0 <= segment < len(arguments)
            else None
        )
        resolved = _resolve_annotation_path(item_annotation, remaining)
        tail = resolved if resolved is not None else list(remaining)
        return [segment, *tail]

    if origin is dict:
        segment = segments[0]
        if type(segment) not in (str, int):
            return None
        remaining = segments[1:]
        arguments = get_args(annotation)
        value_annotation = arguments[1] if len(arguments) == 2 else None
        resolved = _resolve_annotation_path(value_annotation, remaining)
        tail = resolved if resolved is not None else list(remaining)
        return [segment, *tail]

    return None


def _resolve_route_path(
    prefix: object,
    segments: tuple[object, ...] | list[object],
    route: object,
) -> list[object] | None:
    if prefix == "body":
        body_field = getattr(route, "body_field", None)
        if body_field is None:
            return None
        return _resolve_annotation_path(_field_annotation(body_field), segments)

    group_name = _PARAMETER_GROUPS.get(prefix) if type(prefix) is str else None
    dependant = getattr(route, "dependant", None)
    parameters: list[object] = []
    pending = [dependant] if dependant is not None else []
    while pending:
        current = pending.pop()
        parameters.extend(getattr(current, group_name, ()) if group_name else ())
        pending.extend(getattr(current, "dependencies", ()))
    if not segments or type(segments[0]) is not str:
        return None
    for field in parameters:
        name = getattr(field, "name", None)
        if type(name) is not str or segments[0] not in _field_names(name, field):
            continue
        remaining = segments[1:]
        resolved = _resolve_annotation_path(_field_annotation(field), remaining)
        tail = resolved if resolved is not None else list(remaining)
        return [_field_output_name(name, field), *tail]

    flattened_resolutions: list[list[object]] = []
    for field in parameters:
        resolved = _resolve_annotation_path(_field_annotation(field), segments)
        if resolved is not None and resolved not in flattened_resolutions:
            flattened_resolutions.append(resolved)
    if len(flattened_resolutions) == 1:
        return flattened_resolutions[0]
    return None


def _normalize_validation_location(
    location: object,
    *,
    route: object = None,
    error_type: object = None,
) -> str:
    """Render a FastAPI location as the canonical frontend field identity."""

    if error_type == "json_invalid":
        return _ROOT_LOCATION
    if type(location) not in (list, tuple) or not location:
        return _ROOT_LOCATION

    first = location[0]
    start = 1 if type(first) is str and first in _TRANSPORT_PREFIXES else 0
    segments = location[start:]
    if route is not None:
        resolved = _resolve_route_path(first, segments, route)
        if resolved is not None:
            segments = resolved
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
