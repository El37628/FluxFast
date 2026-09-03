/** Framework-neutral types for validating generated JSON contracts. */

export type ValidationPathSegment = string | number;
export type ValidationPath = readonly ValidationPathSegment[];

export interface ValidationIssue {
  path: ValidationPath;
  code: string;
  message: string;
}

export type ValidationResult<T> =
  | {
      valid: true;
      value: T;
      issues: readonly [];
    }
  | {
      valid: false;
      issues: readonly ValidationIssue[];
    };

export interface FluxValidator<T> {
  validate(value: unknown): ValidationResult<T>;
  is(value: unknown): value is T;
  assert(value: unknown): T;
}

export interface ValidationLimits {
  /** Maximum nested value depth. The root value is depth zero. */
  maxDepth?: number;
  /** Maximum number of issues retained for one validation call. */
  maxIssues?: number;
  /** Maximum evaluator operations spent on one validation call. */
  maxOperations?: number;
}

export interface ValidationOptions extends ValidationLimits {
  /** Equivalent limits can also be supplied as a grouped option. */
  limits?: ValidationLimits;
}

interface ValidationPlanBase {
  /** Accept null in addition to the node's normal value domain. */
  nullable?: boolean;
  /** Accept undefined when this node is used directly. */
  optional?: boolean;
  /** Local named plans used by ref nodes, including recursive plans. */
  definitions?: Readonly<Record<string, ValidationPlan>>;
  /** Metadata is intentionally ignored by the evaluator. */
  title?: string;
  description?: string;
  examples?: readonly unknown[];
}

export interface ValidationAnyPlan extends ValidationPlanBase {
  kind: "any";
}

export interface ValidationNeverPlan extends ValidationPlanBase {
  kind: "never";
}

export interface ValidationNullPlan extends ValidationPlanBase {
  kind: "null";
}

export interface ValidationBooleanPlan extends ValidationPlanBase {
  kind: "boolean";
}

export interface ValidationStringPlan extends ValidationPlanBase {
  kind: "string";
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  format?: string;
}

export interface ValidationNumberPlan extends ValidationPlanBase {
  kind: "number" | "integer";
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  multipleOf?: number;
}

export interface ValidationLiteralPlan extends ValidationPlanBase {
  kind: "literal";
  value: unknown;
}

export interface ValidationEnumPlan extends ValidationPlanBase {
  kind: "enum";
  values: readonly unknown[];
}

export interface ValidationArrayPlan extends ValidationPlanBase {
  kind: "array";
  items?: ValidationPlan | boolean;
  prefixItems?: readonly ValidationPlan[];
  minItems?: number;
  maxItems?: number;
}

export interface ValidationTuplePlan extends ValidationPlanBase {
  kind: "tuple";
  items: readonly ValidationPlan[];
  /** When omitted, tuple length must exactly match items.length. */
  rest?: ValidationPlan | false;
}

export interface ValidationObjectPlan extends ValidationPlanBase {
  kind: "object";
  properties?: Readonly<Record<string, ValidationPlan>>;
  required?: readonly string[];
  additionalProperties?: ValidationPlan | boolean;
}

export interface ValidationUnionPlan extends ValidationPlanBase {
  kind: "union";
  anyOf: readonly ValidationPlan[];
  /** Set for oneOf semantics while retaining the compact union shape. */
  oneOf?: boolean;
}

export interface ValidationOneOfPlan extends ValidationPlanBase {
  kind: "oneOf";
  anyOf: readonly ValidationPlan[];
}

export interface ValidationIntersectionPlan extends ValidationPlanBase {
  kind: "intersection";
  allOf: readonly ValidationPlan[];
}

export type ValidationReferenceTarget =
  | { name: string; ref?: never }
  | { ref: string; name?: never };

export type ValidationRefPlan = ValidationPlanBase &
  ValidationReferenceTarget & {
    kind: "ref";
  };

export type ValidationNode =
  | ValidationAnyPlan
  | ValidationNeverPlan
  | ValidationNullPlan
  | ValidationBooleanPlan
  | ValidationStringPlan
  | ValidationNumberPlan
  | ValidationLiteralPlan
  | ValidationEnumPlan
  | ValidationArrayPlan
  | ValidationTuplePlan
  | ValidationObjectPlan
  | ValidationUnionPlan
  | ValidationOneOfPlan
  | ValidationIntersectionPlan
  | ValidationRefPlan;

/** Boolean plans mirror JSON Schema's true/false schemas. */
export type ValidationPlan = ValidationNode | boolean;

export interface ValidationPlanDocument {
  root: ValidationPlan;
  definitions?: Readonly<Record<string, ValidationPlan>>;
}

export function isValidationPlanDocument(
  value: ValidationPlan | ValidationPlanDocument
): value is ValidationPlanDocument {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    "root" in value
  );
}
