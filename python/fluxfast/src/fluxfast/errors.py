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


class ValidationError(FluxFastError):
    """Raised when form/request validation fails."""


class PageNotFoundError(FluxFastError):
    """Raised when a requested page route is not registered."""


class ScopeError(FluxFastError):
    """Raised on invalid cache scope usage."""


class FluxFastLiveScopeError(ScopeError):
    """Raised when a live resource has no stable reusable scope."""
