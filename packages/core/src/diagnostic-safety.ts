const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/g;

const SAFE_ERROR_TYPES = new Set([
  "AbortError",
  "AggregateError",
  "Error",
  "EvalError",
  "MutationError",
  "NetworkError",
  "ProtocolError",
  "RangeError",
  "ReferenceError",
  "ResourceCacheError",
  "ResourceContractError",
  "ResourceError",
  "SyntaxError",
  "TransportError",
  "TypeError",
  "URIError",
  "UnknownError",
  "UpstreamUnavailable",
  "ValidationError",
  "VersionMismatchError",
]);

/** Bound development-only display text and remove header/control characters. */
export function diagnosticText(
  value: string,
  maximumLength: number = 256
): string {
  const safe = value.replace(CONTROL_CHARACTERS, "");
  return safe.length <= maximumLength
    ? safe
    : `${safe.slice(0, Math.max(0, maximumLength - 1))}…`;
}

/** Collapse throwable-controlled names to a documented, value-free category. */
export function diagnosticErrorType(error: unknown): string {
  const name = typeof error === "string"
    ? error
    : error instanceof Error && error.name
      ? error.name
      : "UnknownError";
  return SAFE_ERROR_TYPES.has(name) ? name : "UnknownError";
}
