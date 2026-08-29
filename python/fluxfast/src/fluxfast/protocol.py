"""FluxFast wire protocol definitions and envelopes."""

from typing import Any, Generic, Literal, TypeVar

from pydantic import BaseModel, Field

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


class PageEnvelope(BaseModel):
    protocol: Literal["fluxfast/1"] = PROTOCOL_VERSION
    page: PageDescriptor
    resources: dict[str, ResourceWireRecord[Any]] = Field(default_factory=dict)


class MutationPayload(BaseModel):
    patches: dict[str, list[dict[str, Any]]] | None = None
    invalidate: list[str] | None = None
    redirect: str | None = None
    externalRedirect: str | None = None


class MutationEnvelope(BaseModel):
    protocol: Literal["fluxfast/1"] = PROTOCOL_VERSION
    mutation: MutationPayload


class ErrorDetail(BaseModel):
    type: str
    message: str
    details: Any = None


class ErrorEnvelope(BaseModel):
    protocol: Literal["fluxfast/1"] = PROTOCOL_VERSION
    error: ErrorDetail
