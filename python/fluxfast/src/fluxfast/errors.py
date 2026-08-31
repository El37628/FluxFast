"""FluxFast exception hierarchy."""

from typing import Any


class FluxFastError(Exception):
    """Base exception for all FluxFast errors."""

    def __init__(self, message: str, details: Any = None):
        super().__init__(message)
        self.message = message
        self.details = details


class ProtocolError(FluxFastError):
    """Raised when wire protocol constraints or versions are violated."""


class ResourceError(FluxFastError):
    """Raised when a resource loader fails during execution."""


class ResourceContractError(ResourceError):
    """Raised when a typed resource violates its declared contract."""


class ResourceCacheError(FluxFastError):
    """Base error for configured resource-cache backend failures."""


class ResourceCacheUnavailableError(ResourceCacheError):
    """Raised when the configured shared cache cannot complete an operation."""


class ResourceCacheSerializationError(ResourceCacheError):
    """Raised when a resource cannot be stored as bounded safe cache data."""


class ValidationError(FluxFastError):
    """Raised when form/request validation fails."""


class PageNotFoundError(FluxFastError):
    """Raised when a requested page route is not registered."""


class ScopeError(FluxFastError):
    """Raised on invalid cache scope usage."""


class FluxFastLiveScopeError(ScopeError):
    """Raised when a live resource has no stable reusable scope."""
