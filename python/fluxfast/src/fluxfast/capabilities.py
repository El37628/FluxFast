"""Bounded parsing and lookup for FluxFast client capabilities."""

import re
from typing import Final

from starlette.requests import Request

from .headers import HEADER_CAPABILITIES

CAPABILITY_DEFERRED_RESOURCES: Final = "deferred-resources"
CAPABILITY_LIVE_RESOURCES: Final = "live-resources"
SUPPORTED_CAPABILITIES: Final = frozenset(
    {CAPABILITY_DEFERRED_RESOURCES, CAPABILITY_LIVE_RESOURCES}
)

MAX_CAPABILITIES_HEADER_BYTES: Final = 2048
MAX_CAPABILITIES: Final = 32
MAX_CAPABILITY_LENGTH: Final = 64

_CAPABILITY_TOKEN = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")


def parse_capabilities_header(header_value: str | None) -> frozenset[str]:
    """Return recognized capabilities from a bounded, comma-separated header."""
    if not header_value or not header_value.strip():
        return frozenset()

    try:
        encoded = header_value.encode("ascii")
    except UnicodeEncodeError:
        return frozenset()
    if len(encoded) > MAX_CAPABILITIES_HEADER_BYTES:
        return frozenset()

    tokens = header_value.split(",", MAX_CAPABILITIES)
    if len(tokens) > MAX_CAPABILITIES:
        return frozenset()

    recognized: set[str] = set()
    for raw_token in tokens:
        token = raw_token.strip()
        if (
            not token
            or len(token) > MAX_CAPABILITY_LENGTH
            or _CAPABILITY_TOKEN.fullmatch(token) is None
        ):
            continue
        if token in SUPPORTED_CAPABILITIES:
            recognized.add(token)
    return frozenset(recognized)


def client_supports(request: Request, capability: str) -> bool:
    """Return whether the request safely advertises a supported capability."""
    if capability not in SUPPORTED_CAPABILITIES:
        return False
    return capability in parse_capabilities_header(
        request.headers.get(HEADER_CAPABILITIES)
    )
