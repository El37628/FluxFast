"""FluxFast wire protocol definitions and envelopes."""

from typing import Any, Generic, Literal, TypeVar
from urllib.parse import urlparse

from pydantic import BaseModel, Field, field_validator

PROTOCOL_VERSION: Literal["fluxfast/1"] = "fluxfast/1"
PROTOCOL_MEDIA_TYPE: str = "application/vnd.fluxfast+json"

T = TypeVar("T")


def _is_origin_relative_redirect(value: str) -> bool:
    """Return whether a redirect is safe for browser origin-relative navigation."""

    return (
        value.startswith("/")
        and not value.startswith("//")
        and "\\" not in value
        and not any(ord(char) < 32 or 127 <= ord(char) <= 159 for char in value)
    )


class ResourceWireRecord(BaseModel, Generic[T]):
    version: str
    value: T


class PageDescriptor(BaseModel):
    component: str
    url: str = ""
    meta: dict[str, Any] = Field(default_factory=dict)


class ErrorDetail(BaseModel):
    type: str
    message: str
    details: Any = None


class ResourceErrorDetail(ErrorDetail):
    """Public, sanitized error information for a single page resource."""


class PageEnvelope(BaseModel):
    protocol: Literal["fluxfast/1"] = PROTOCOL_VERSION
    page: PageDescriptor
    resources: dict[str, ResourceWireRecord[Any]] = Field(default_factory=dict)
    resourceKeys: list[str] | None = None
    deferred: list[str] | None = None
    live: list[str] | None = None
    resourceErrors: dict[str, ResourceErrorDetail] | None = None
    appVersion: str | None = None

    @field_validator("resourceKeys", "deferred", "live", mode="before")
    @classmethod
    def validate_resource_key_list(cls, value: Any) -> Any:
        if value is None:
            return value
        if not isinstance(value, list) or any(
            not isinstance(item, str) for item in value
        ):
            raise ValueError("resource metadata must be an array of strings")
        return value

    @field_validator("resourceErrors", mode="before")
    @classmethod
    def validate_resource_errors(cls, value: Any) -> Any:
        if value is not None and not isinstance(value, dict):
            raise ValueError("resourceErrors must be an object")
        return value


class MutationPayload(BaseModel):
    patches: dict[str, list[dict[str, Any]]] | None = None
    invalidate: list[str] | None = None
    redirect: str | None = None
    externalRedirect: str | None = None

    @field_validator("patches", mode="before")
    @classmethod
    def validate_patches(cls, value: Any) -> Any:
        if value is None or not isinstance(value, dict):
            return value
        allowed_operations = {
            "replace-resource",
            "merge-object",
            "replace-item",
            "remove-item",
            "append-item",
        }
        for key, patches in value.items():
            if not isinstance(patches, list):
                # Pydantic field validators wrap ValueError, not TypeError.
                raise ValueError(  # noqa: TRY004
                    f"mutation patches for {key!r} must be an array"
                )
            for patch in patches:
                if not isinstance(patch, dict):
                    raise ValueError(  # noqa: TRY004
                        f"mutation patches for {key!r} must contain objects"
                    )
                if patch.get("op") not in allowed_operations:
                    raise ValueError(f"invalid mutation patch operation for {key!r}")
                patch_id = patch.get("id")
                has_id = (
                    "id" in patch
                    and not isinstance(patch_id, bool)
                    and isinstance(patch_id, (str, int))
                )
                if "id" in patch and not has_id:
                    raise ValueError(
                        f"invalid mutation patch id for {key!r}"
                    )
                match = patch.get("match")
                if "match" in patch and not isinstance(match, dict):
                    raise ValueError(
                        f"invalid mutation patch match for {key!r}"
                    )
                has_identity = has_id or (isinstance(match, dict) and bool(match))
                operation = patch["op"]
                if operation in {
                    "replace-resource",
                    "merge-object",
                    "append-item",
                } and "value" not in patch:
                    raise ValueError(f"incomplete {operation!r} patch for {key!r}")
                if operation in {"replace-item", "remove-item"} and not has_identity:
                    raise ValueError(f"incomplete {operation!r} patch for {key!r}")
                if operation == "replace-item" and "value" not in patch:
                    raise ValueError(f"incomplete {operation!r} patch for {key!r}")
                if operation == "merge-object" and not isinstance(
                    patch.get("value"), dict
                ):
                    raise ValueError(
                        f"incomplete {operation!r} patch for {key!r}"
                    )
        return value

    @field_validator("redirect")
    @classmethod
    def validate_redirect(cls, value: str | None) -> str | None:
        if value is not None and not _is_origin_relative_redirect(value):
            raise ValueError("redirect must be origin-relative")
        return value

    @field_validator("externalRedirect")
    @classmethod
    def validate_external_redirect(cls, value: str | None) -> str | None:
        if value is None:
            return value
        parsed = urlparse(value)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            raise ValueError("externalRedirect must be an absolute HTTP(S) URL")
        return value


class MutationEnvelope(BaseModel):
    protocol: Literal["fluxfast/1"] = PROTOCOL_VERSION
    mutation: MutationPayload


class ErrorEnvelope(BaseModel):
    protocol: Literal["fluxfast/1"] = PROTOCOL_VERSION
    error: ErrorDetail
