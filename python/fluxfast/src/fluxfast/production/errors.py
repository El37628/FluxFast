"""Shared production validation errors."""


class ProductionValidationError(RuntimeError):
    """Raised when an application cannot safely start in production."""


class ProductionBuildMissingError(ProductionValidationError):
    """Raised when the frontend has no completed Next.js production build."""


class ProductionFrontendError(ProductionValidationError):
    """Raised when the frontend production command cannot be resolved."""
