"""Terminal-safe redaction for production diagnostics and errors."""

from __future__ import annotations

import re

_URL_CREDENTIALS = re.compile(
    r"(?P<scheme>[a-z][a-z0-9+.-]*://)[^\s/@]+@",
    re.IGNORECASE,
)
_SECRET_ENVIRONMENT_VALUE = re.compile(
    r"\b(?P<name>(?:[A-Z][A-Z0-9_]*_)?"
    r"(?:KEY(?:_ID)?|TOKEN|SECRET(?:_KEY)?|PASSWORD|PASSWD|CREDENTIALS?))"
    r"\s*=\s*(?P<value>[^\s,;]+)",
    re.IGNORECASE,
)


def safe_production_text(value: str, *, limit: int = 1_000) -> str:
    """Redact common credentials and return one bounded printable line."""

    redacted = _URL_CREDENTIALS.sub(r"\g<scheme>***@", value)
    redacted = _SECRET_ENVIRONMENT_VALUE.sub(r"\g<name>=***", redacted)
    rendered = "".join(
        character if character.isprintable() else "?" for character in redacted
    )
    if len(rendered) <= limit:
        return rendered
    return rendered[: limit - 1] + "…"
