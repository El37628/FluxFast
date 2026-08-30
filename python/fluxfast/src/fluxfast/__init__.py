"""FluxFast — high-performance server-driven application runtime for FastAPI."""

from .app import FluxFast
from .cache import CachedResource, MemoryResourceCache, ResourceCacheBackend
from .capabilities import CAPABILITY_DEFERRED_RESOURCES, client_supports
from .errors import (
    FluxFastError,
    PageNotFoundError,
    ProtocolError,
    ResourceError,
    ScopeError,
    ValidationError,
)
from .headers import HEADER_CAPABILITIES
from .mutation import (
    InvalidateResource,
    MutationResult,
    append_item,
    flux_external_redirect,
    flux_redirect,
    invalidate_resource,
    merge_object,
    mutation,
    remove_item,
    replace_item,
    replace_resource,
)
from .page import Page
from .protocol import (
    PROTOCOL_MEDIA_TYPE,
    PROTOCOL_VERSION,
    ErrorDetail,
    ErrorEnvelope,
    MutationEnvelope,
    MutationPayload,
    PageDescriptor,
    PageEnvelope,
    ResourceErrorDetail,
    ResourceWireRecord,
)
from .resource import ResourceLoader, ResourceSpec, resource
from .router import FluxRouter
from .scope import CacheScope, ScopeType, scope

__version__ = "0.3.0"

__all__ = [
    "CAPABILITY_DEFERRED_RESOURCES",
    "HEADER_CAPABILITIES",
    "PROTOCOL_MEDIA_TYPE",
    "PROTOCOL_VERSION",
    "CacheScope",
    "CachedResource",
    "ErrorDetail",
    "ErrorEnvelope",
    "FluxFast",
    "FluxFastError",
    "FluxRouter",
    "InvalidateResource",
    "MemoryResourceCache",
    "MutationEnvelope",
    "MutationPayload",
    "MutationResult",
    "Page",
    "PageDescriptor",
    "PageEnvelope",
    "PageNotFoundError",
    "ProtocolError",
    "ResourceCacheBackend",
    "ResourceError",
    "ResourceErrorDetail",
    "ResourceLoader",
    "ResourceSpec",
    "ResourceWireRecord",
    "ScopeError",
    "ScopeType",
    "ValidationError",
    "append_item",
    "client_supports",
    "flux_external_redirect",
    "flux_redirect",
    "invalidate_resource",
    "merge_object",
    "mutation",
    "remove_item",
    "replace_item",
    "replace_resource",
    "resource",
    "scope",
]
