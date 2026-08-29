/**
 * FluxFast error classes for core client runtime.
 */

export class FluxFastError extends Error {
  public readonly details?: unknown;

  constructor(message: string, details?: unknown) {
    super(message);
    this.name = "FluxFastError";
    this.details = details;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class ProtocolError extends FluxFastError {
  constructor(message: string, details?: unknown) {
    super(message, details);
    this.name = "ProtocolError";
  }
}

export class TransportError extends FluxFastError {
  public readonly status?: number;

  constructor(message: string, status?: number, details?: unknown) {
    super(message, details);
    this.name = "TransportError";
    this.status = status;
  }
}

export class PageNotFoundError extends FluxFastError {
  constructor(message: string, details?: unknown) {
    super(message, details);
    this.name = "PageNotFoundError";
  }
}

export class ComponentResolutionError extends FluxFastError {
  constructor(message: string, details?: unknown) {
    super(message, details);
    this.name = "ComponentResolutionError";
  }
}

export class ValidationError extends FluxFastError {
  constructor(message: string, details?: unknown) {
    super(message, details);
    this.name = "ValidationError";
  }
}

export class MutationError extends FluxFastError {
  constructor(message: string, details?: unknown) {
    super(message, details);
    this.name = "MutationError";
  }
}

export class ResourceError extends FluxFastError {
  constructor(message: string, details?: unknown) {
    super(message, details);
    this.name = "ResourceError";
  }
}

export class VersionMismatchError extends ProtocolError {
  constructor(message: string, details?: unknown) {
    super(message, details);
    this.name = "VersionMismatchError";
  }
}
