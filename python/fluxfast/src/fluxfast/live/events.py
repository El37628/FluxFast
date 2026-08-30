"""Validated wire events for Live Resource synchronization."""

from typing import Annotated, Any, Final, Literal

from pydantic import BaseModel, Field, field_validator

from ..mutation import _validate_patch
from ..protocol import PROTOCOL_VERSION

LIVE_EVENT_NAME: Final = "fluxfast"
LIVE_RESYNC_REASONS: Final = (
    "overflow",
    "reconnect",
    "broker-recovery",
    "server",
)

LiveResyncReason = Literal["overflow", "reconnect", "broker-recovery", "server"]

MAX_LIVE_EVENT_KEYS: Final = 100
MAX_LIVE_RESOURCE_KEY_LENGTH: Final = 128
MAX_LIVE_CLIENT_ID_LENGTH: Final = 64


def _validate_resource_keys(value: Any) -> Any:
    if not isinstance(value, list) or any(not isinstance(key, str) for key in value):
        raise ValueError("live event keys must be an array of strings")
    if len(value) > MAX_LIVE_EVENT_KEYS:
        raise ValueError(f"live events may contain at most {MAX_LIVE_EVENT_KEYS} keys")
    for key in value:
        if (
            not key.strip()
            or len(key) > MAX_LIVE_RESOURCE_KEY_LENGTH
            or "," in key
            or any(ord(char) < 32 for char in key)
        ):
            raise ValueError("live event resource keys must be safe non-empty strings")
    return value


def _validate_origin_client_id(value: Any) -> Any:
    if value is None:
        return value
    if (
        not isinstance(value, str)
        or not value
        or len(value) > MAX_LIVE_CLIENT_ID_LENGTH
        or not value.isascii()
        or any(ord(char) < 33 or ord(char) > 126 for char in value)
    ):
        raise ValueError(
            "originClientId must be a non-empty printable ASCII string of at most "
            f"{MAX_LIVE_CLIENT_ID_LENGTH} characters"
        )
    return value


class LiveReadyEvent(BaseModel):
    protocol: Literal["fluxfast/1"] = PROTOCOL_VERSION
    type: Literal["ready"] = "ready"
    keys: list[str]

    _keys = field_validator("keys", mode="before")(_validate_resource_keys)


class LiveInvalidateEvent(BaseModel):
    protocol: Literal["fluxfast/1"] = PROTOCOL_VERSION
    type: Literal["invalidate"] = "invalidate"
    keys: list[str]
    originClientId: str | None = None

    _keys = field_validator("keys", mode="before")(_validate_resource_keys)
    _origin_client_id = field_validator("originClientId", mode="before")(
        _validate_origin_client_id
    )


class LivePatchEvent(BaseModel):
    protocol: Literal["fluxfast/1"] = PROTOCOL_VERSION
    type: Literal["patch"] = "patch"
    patches: dict[str, list[dict[str, Any]]]
    originClientId: str | None = None

    @field_validator("patches", mode="before")
    @classmethod
    def validate_patches(cls, value: Any) -> Any:
        if not isinstance(value, dict):
            # Pydantic v2 no longer converts TypeError raised by validators.
            raise ValueError("live patches must be an object")  # noqa: TRY004
        keys = _validate_resource_keys(list(value.keys()))
        for key in keys:
            patches = value[key]
            if not isinstance(patches, list) or any(
                not isinstance(patch, dict) for patch in patches
            ):
                raise ValueError(f"live patches for '{key}' must be an array of objects")
            for patch in patches:
                _validate_patch(key, patch)
        return value

    _origin_client_id = field_validator("originClientId", mode="before")(
        _validate_origin_client_id
    )


class LiveResyncEvent(BaseModel):
    protocol: Literal["fluxfast/1"] = PROTOCOL_VERSION
    type: Literal["resync"] = "resync"
    keys: list[str]
    reason: LiveResyncReason

    _keys = field_validator("keys", mode="before")(_validate_resource_keys)


LiveEvent = Annotated[
    LiveReadyEvent | LiveInvalidateEvent | LivePatchEvent | LiveResyncEvent,
    Field(discriminator="type"),
]
