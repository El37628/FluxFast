import { ValidationError } from "../errors";
import {
  compileValidationPlan,
  evaluateValidationPlan,
  type CompiledValidationPlan
} from "./plan";
import type {
  FluxValidator,
  ValidationPlan,
  ValidationPlanDocument,
  ValidationOptions,
  ValidationResult
} from "./types";

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

/** Expose the prepared representation for generated or advanced integrations. */
export function prepareValidationPlan(
  plan: ValidationPlan | ValidationPlanDocument,
  options: ValidationOptions = {}
): CompiledValidationPlan {
  return compileValidationPlan(plan, options);
}
