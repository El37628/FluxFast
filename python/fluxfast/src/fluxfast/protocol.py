"""FluxFast wire protocol definitions and envelopes."""

from typing import Any, Generic, Literal, TypeVar

from pydantic import BaseModel, Field, field_validator

PROTOCOL_VERSION: Literal["fluxfast/1"] = "fluxfast/1"
PROTOCOL_MEDIA_TYPE: str = "application/vnd.fluxfast+json"

T = TypeVar("T")


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


class MutationEnvelope(BaseModel):
    protocol: Literal["fluxfast/1"] = PROTOCOL_VERSION
    mutation: MutationPayload


class ErrorEnvelope(BaseModel):
    protocol: Literal["fluxfast/1"] = PROTOCOL_VERSION
    error: ErrorDetail
