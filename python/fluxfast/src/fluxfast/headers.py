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
HEADER_SERVER_TIMING = "Server-Timing"

# Header safety limits
MAX_KNOWN_RESOURCES = 100
MAX_DECODED_BYTES = 16 * 1024  # 16 KiB
MAX_KEY_LENGTH = 128
MAX_VERSION_LENGTH = 128
MAX_ENCODED_CHARS = ((MAX_DECODED_BYTES + 2) // 3) * 4 + 4


def is_fluxfast_request(request: Request) -> bool:
    """Determine whether incoming request is a FluxFast navigation or API request."""
    if request.headers.get(HEADER_FLUXFAST) == "1":
        return True
    accept = request.headers.get("accept", "")
    return PROTOCOL_MEDIA_TYPE in accept.lower()


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
