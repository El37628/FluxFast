import { ValidationError } from "../errors.js";
import { createValidationIssue } from "./issues.js";
import {
  compileValidationPlan,
  evaluateValidationPlan,
  type CompiledValidationPlan
} from "./plan.js";
import type {
  FluxValidator,
  ValidationIssue,
  ValidationPlan,
  ValidationPlanDocument,
  ValidationOptions,
  ValidationResult
} from "./types.js";

/**
 * A synchronous application-specific check that runs after the generated
 * validator has accepted a value.
 *
 * Returning `null` or `undefined` keeps the value valid. Returning an issue
 * rejects it without changing or transforming the validated value.
 */
export type ValidatorRefinement<T> = (
  value: T
) => ValidationIssue | null | undefined;

function isValidationPath(value: unknown): value is readonly (string | number)[] {
  if (!Array.isArray(value)) return false;
  for (const segment of value) {
    if (typeof segment !== "string" && typeof segment !== "number") return false;
  }
  return true;
}

function normalizeRefinementIssue(issue: unknown): ValidationIssue {
  if (typeof issue !== "object" || issue === null) {
    throw new TypeError(
      "[fluxfast] Refinement must return a ValidationIssue, null, or undefined"
    );
  }
  const candidate = issue as {
    path?: unknown;
    code?: unknown;
    message?: unknown;
  };
  if (!isValidationPath(candidate.path)) {
    throw new TypeError(
      "[fluxfast] Refinement issue.path must be an array of strings or numbers"
    );
  }
  if (typeof candidate.code !== "string") {
    throw new TypeError("[fluxfast] Refinement issue.code must be a string");
  }
  if (typeof candidate.message !== "string") {
    throw new TypeError("[fluxfast] Refinement issue.message must be a string");
  }
  return createValidationIssue(candidate.path, candidate.code, candidate.message);
}

/** Build a reusable validator from a deterministic, generated validation plan. */
export function createValidator<T>(
  plan: ValidationPlan | ValidationPlanDocument,
  options: ValidationOptions = {}
): FluxValidator<T> {
  const compiled = compileValidationPlan(plan, options);
  const validator: FluxValidator<T> = {
    validate(value: unknown): ValidationResult<T> {
      return evaluateValidationPlan<T>(compiled, value);
    },
    is(value: unknown): value is T {
      return evaluateValidationPlan<T>(compiled, value).valid;
    },
    assert(value: unknown): T {
      const result = evaluateValidationPlan<T>(compiled, value);
      if (!result.valid) {
        throw new ValidationError("Validation failed", result.issues);
      }
      return result.value;
    }
  };
  return Object.freeze(validator);
}

/**
 * Compose one small, synchronous application-specific check with a validator.
 *
 * The refinement only runs after the wrapped validator succeeds, so it always
 * receives the validator's typed value. It may report one issue, or return
 * `null`/`undefined` to keep the value valid. Refinements cannot return a
 * replacement value and should not mutate the received value. They are
 * synchronous; exceptions are programmer errors and propagate unchanged.
 */
export function refineValidator<T>(
  validator: FluxValidator<T>,
  refinement: ValidatorRefinement<T>
): FluxValidator<T> {
  const validate = (value: unknown): ValidationResult<T> => {
    const result = validator.validate(value);
    if (!result.valid) return result;

    const issue = refinement(result.value);
    if (issue === null || issue === undefined) return result;

    return Object.freeze({
      valid: false as const,
      issues: Object.freeze([
        normalizeRefinementIssue(issue)
      ])
    });
  };
  const refined: FluxValidator<T> = {
    validate,
    is(value: unknown): value is T {
      return validate(value).valid;
    },
    assert(value: unknown): T {
      const result = validate(value);
      if (!result.valid) {
        throw new ValidationError("Validation failed", result.issues);
      }
      return result.value;
    }
  };
  return Object.freeze(refined);
}

/** Expose the prepared representation for generated or advanced integrations. */
export function prepareValidationPlan(
  plan: ValidationPlan | ValidationPlanDocument,
  options: ValidationOptions = {}
): CompiledValidationPlan {
  return compileValidationPlan(plan, options);
}
