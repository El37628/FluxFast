"""Shared production validation errors."""


class ProductionValidationError(RuntimeError):
    """Raised when an application cannot safely start in production."""


class ProductionBuildMissingError(ProductionValidationError):
    """Raised when the frontend has no completed Next.js production build."""


class ProductionBuildError(ProductionValidationError):
    """Raised when a production frontend cannot be validated or built."""


class ProductionFrontendError(ProductionValidationError):
    """Raised when the frontend production command cannot be resolved."""
