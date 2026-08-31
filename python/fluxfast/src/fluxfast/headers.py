"""FluxFast HTTP headers parsing, formatting, and safety limits."""

import base64
import binascii
import json
import logging

from starlette.requests import Request

from .errors import ProtocolError
from .protocol import PROTOCOL_MEDIA_TYPE

logger = logging.getLogger("fluxfast.headers")

HEADER_FLUXFAST = "X-FluxFast"
HEADER_PROTOCOL = "X-FluxFast-Protocol"
HEADER_VISIT = "X-FluxFast-Visit"
HEADER_KNOWN = "X-FluxFast-Known"
HEADER_ONLY = "X-FluxFast-Only"
HEADER_CAPABILITIES = "X-FluxFast-Capabilities"
HEADER_APP_VERSION = "X-FluxFast-App-Version"
HEADER_DEFERRED_PENDING = "X-FluxFast-Deferred-Pending"
HEADER_DEFERRED_ERRORS = "X-FluxFast-Deferred-Errors"
HEADER_LIVE = "X-FluxFast-Live"
HEADER_LIVE_KEYS = "X-FluxFast-Live-Keys"
HEADER_LIVE_RESOURCES = "X-FluxFast-Live-Resources"
HEADER_CLIENT_ID = "X-FluxFast-Client-ID"
HEADER_SERVER_TIMING = "Server-Timing"

# Header safety limits
MAX_KNOWN_RESOURCES = 100
MAX_DECODED_BYTES = 16 * 1024  # 16 KiB
MAX_KEY_LENGTH = 128
MAX_VERSION_LENGTH = 128
MAX_ENCODED_CHARS = ((MAX_DECODED_BYTES + 2) // 3) * 4 + 4
MAX_LIVE_KEYS_HEADER_BYTES = 16 * 1024
MAX_LIVE_KEYS = 100
MAX_CLIENT_ID_LENGTH = 64


def is_fluxfast_request(request: Request) -> bool:
    """Determine whether incoming request is a FluxFast navigation or API request."""
    if request.headers.get(HEADER_FLUXFAST) == "1":
        return True
    accept = request.headers.get("accept", "")
    return PROTOCOL_MEDIA_TYPE in accept.lower()


def is_live_request(request: Request) -> bool:
    """Determine whether a page request asks for a Live Resource stream."""

    return request.headers.get(HEADER_LIVE) == "1"


def validate_protocol_header(request: Request) -> None:
    """Reject an explicitly unsupported wire protocol version."""
    supplied = request.headers.get(HEADER_PROTOCOL)
    if supplied is not None and supplied != "1":
        raise ProtocolError(
            f"Unsupported FluxFast protocol header '{supplied}'; expected '1'",
            details={"expected": "1", "received": supplied},
        )


def parse_known_header(header_val: str | None) -> dict[str, str]:
    """Parse and validate X-FluxFast-Known header containing base64url encoded known versions map."""
    if not header_val or not header_val.strip():
        return {}

    try:
        # Base64url decode with padding tolerance
        padded = header_val.strip()
        if len(padded) > MAX_ENCODED_CHARS:
            logger.warning("X-FluxFast-Known encoded payload exceeded safety limit")
            return {}
        padding_needed = (4 - len(padded) % 4) % 4
        padded += "=" * padding_needed
        raw_bytes = base64.urlsafe_b64decode(padded)

        if len(raw_bytes) > MAX_DECODED_BYTES:
            logger.warning("X-FluxFast-Known payload exceeded maximum decoded size (%d bytes)", len(raw_bytes))
            return {}

        data = json.loads(raw_bytes.decode("utf-8"))
        if not isinstance(data, dict):
            return {}

        result: dict[str, str] = {}
        for k, v in data.items():
            if len(result) >= MAX_KNOWN_RESOURCES:
                break
            if (
                isinstance(k, str)
                and isinstance(v, str)
                and len(k) <= MAX_KEY_LENGTH
                and len(v) <= MAX_VERSION_LENGTH
            ):
                result[k] = v
        return result
    except (ValueError, UnicodeError, binascii.Error) as e:
        logger.debug("Failed to decode X-FluxFast-Known header: %s", e)
        return {}


def encode_known_header(known: dict[str, str]) -> str:
    """Encode known version map to base64url string."""
    limited: dict[str, str] = {}
    for key, version in known.items():
        if len(limited) >= MAX_KNOWN_RESOURCES:
            break
        if (
            isinstance(key, str)
            and isinstance(version, str)
            and len(key) <= MAX_KEY_LENGTH
            and len(version) <= MAX_VERSION_LENGTH
        ):
            limited[key] = version
    raw_json = json.dumps(limited, separators=(",", ":")).encode("utf-8")
    if len(raw_json) > MAX_DECODED_BYTES:
        return ""
    return base64.urlsafe_b64encode(raw_json).decode("ascii").rstrip("=")


def parse_only_header(header_val: str | None) -> set[str] | None:
    """Parse X-FluxFast-Only header for partial resource refresh."""
    if not header_val or not header_val.strip():
        return None
    keys = {
        key
        for raw_key in header_val.split(",", MAX_KNOWN_RESOURCES)[:MAX_KNOWN_RESOURCES]
        if (key := raw_key.strip()) and len(key) <= MAX_KEY_LENGTH
    }
    return keys if keys else None


def parse_live_keys_header(header_val: str | None) -> set[str]:
    """Parse strictly bounded logical keys from a live subscription request."""

    if header_val is None or not header_val.strip():
        raise ProtocolError(f"{HEADER_LIVE_KEYS} is required for a live request")
    if len(header_val.encode("utf-8")) > MAX_LIVE_KEYS_HEADER_BYTES:
        raise ProtocolError(
            f"{HEADER_LIVE_KEYS} exceeds {MAX_LIVE_KEYS_HEADER_BYTES} bytes"
        )

    raw_keys = header_val.split(",")
    if len(raw_keys) > MAX_LIVE_KEYS:
        raise ProtocolError(
            f"{HEADER_LIVE_KEYS} may contain at most {MAX_LIVE_KEYS} keys"
        )

    keys: set[str] = set()
    for raw_key in raw_keys:
        key = raw_key.strip()
        if (
            not key
            or len(key) > MAX_KEY_LENGTH
            or any(ord(char) < 32 for char in key)
        ):
            raise ProtocolError(
                f"{HEADER_LIVE_KEYS} contains an invalid resource key"
            )
        keys.add(key)
    return keys


def validate_live_client_id(header_val: str | None) -> str | None:
    """Validate an optional opaque live client identifier."""

    if header_val is None:
        return None
    if (
        not header_val
        or len(header_val) > MAX_CLIENT_ID_LENGTH
        or not header_val.isascii()
        or any(ord(char) < 33 or ord(char) > 126 for char in header_val)
    ):
        raise ProtocolError(
            f"{HEADER_CLIENT_ID} must be printable ASCII of at most "
            f"{MAX_CLIENT_ID_LENGTH} characters"
        )
    return header_val
