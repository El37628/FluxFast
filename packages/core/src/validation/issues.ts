import type {
  ValidationIssue,
  ValidationPath,
  ValidationPathSegment
} from "./types";

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** Render a validation path in a stable, developer-facing form. */
export function formatValidationPath(path: ValidationPath): string {
  if (path.length === 0) return "$";
  let result = "";
  for (const [index, segment] of path.entries()) {
    if (typeof segment === "number") {
      result += index === 0 ? String(segment) : `.${segment}`;
    } else if (IDENTIFIER.test(segment)) {
      result += index === 0 ? segment : `.${segment}`;
    } else {
      result += index === 0
        ? `[${JSON.stringify(segment)}]`
        : `[${JSON.stringify(segment)}]`;
    }
  }
  return result;
}

/** Create an immutable issue so callers cannot mutate validator state. */
export function createValidationIssue(
  path: ValidationPath,
  code: string,
  message: string
): ValidationIssue {
  return Object.freeze({
    path: Object.freeze([...path]) as readonly ValidationPathSegment[],
    code,
    message
  });
}

/** Keep hostile property names out of unbounded diagnostic messages. */
export function displayValidationKey(value: string): string {
  const truncated = value.length > 80 ? `${value.slice(0, 77)}...` : value;
  return JSON.stringify(truncated);
}
