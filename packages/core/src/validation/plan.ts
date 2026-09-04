import { createValidationIssue, displayValidationKey } from "./issues.js";
import {
  isSupportedValidationFormat,
  validationPatternError,
  validateValidationFormat
} from "./formats.js";
import type { ValidationFormat } from "./formats.js";
import type {
  ValidationArrayPlan,
  ValidationIssue,
  ValidationIntersectionPlan,
  ValidationLimits,
  ValidationNode,
  ValidationObjectPlan,
  ValidationPlan,
  ValidationPlanDocument,
  ValidationRefPlan,
  ValidationResult,
  ValidationStringPlan,
  ValidationTuplePlan,
  ValidationOneOfPlan,
  ValidationUnionPlan,
  ValidationOptions
} from "./types.js";
import { isValidationPlanDocument } from "./types.js";

export const DEFAULT_VALIDATION_MAX_DEPTH = 64;
export const DEFAULT_VALIDATION_MAX_ISSUES = 100;
export const DEFAULT_VALIDATION_MAX_OPERATIONS = 100_000;
export const DEFAULT_VALIDATION_MAX_PROPERTIES = 10_000;

interface NormalizedLimits {
  readonly maxDepth: number;
  readonly maxIssues: number;
  readonly maxOperations: number;
  readonly maxProperties: number;
}

export interface CompiledValidationPlan {
  readonly root: ValidationPlan;
  readonly definitions: ReadonlyMap<string, ValidationPlan>;
  readonly patterns: WeakMap<object, RegExp>;
  readonly limits: NormalizedLimits;
}

function pathKey(path: string, key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)
    ? `${path}.${key}`
    : `${path}[${JSON.stringify(key)}]`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") {
    return false;
  }
  try {
    if (Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new TypeError(`[fluxfast] Invalid validation plan at ${path}`);
  }
  return value;
}

function requireBoolean(value: unknown, path: string): void {
  if (typeof value !== "boolean") {
    throw new TypeError(
      `[fluxfast] Invalid validation plan at ${path}: expected a boolean`
    );
  }
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== "string") {
    throw new TypeError(
      `[fluxfast] Invalid validation plan at ${path}: expected a string`
    );
  }
  return value;
}

function requireNonEmptyString(value: unknown, path: string): string {
  const string = requireString(value, path);
  if (string.length === 0) {
    throw new TypeError(
      `[fluxfast] Invalid validation plan at ${path}: expected a non-empty string`
    );
  }
  return string;
}

function requireNonNegativeInteger(value: unknown, path: string): void {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    throw new TypeError(
      `[fluxfast] Invalid validation plan at ${path}: expected a non-negative integer`
    );
  }
}

function requireFiniteNumber(value: unknown, path: string): void {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(
      `[fluxfast] Invalid validation plan at ${path}: expected a finite number`
    );
  }
}

function requireArray(value: unknown, path: string): readonly unknown[] {
  let isArray = false;
  try {
    isArray = Array.isArray(value);
  } catch {
    isArray = false;
  }
  if (!isArray) {
    throw new TypeError(
      `[fluxfast] Invalid validation plan at ${path}: expected an array`
    );
  }
  return value as readonly unknown[];
}

const MAX_VALIDATION_PLAN_VALUES = 100_000;
const MAX_VALIDATION_PLAN_DEPTH = 64;
const MAX_VALIDATION_PLAN_CHILDREN = 10_000;
const MAX_VALIDATION_PLAN_STRING_LENGTH = 65_536;

interface PlanBoundsFrame {
  readonly value: unknown;
  readonly path: string;
  readonly depth: number;
  readonly exit?: boolean;
}

function assertPlanBounds(
  root: ValidationPlan,
  documentDefinitions: unknown
): void {
  const pending: PlanBoundsFrame[] = [{ value: root, path: "$", depth: 0 }];
  if (documentDefinitions !== undefined) {
    pending.push({ value: documentDefinitions, path: "$.definitions", depth: 0 });
  }
  const active = new WeakSet<object>();
  const visited = new WeakSet<object>();
  let values = 0;

  while (pending.length > 0) {
    const frame = pending.pop()!;
    if (frame.exit) {
      active.delete(frame.value as object);
      continue;
    }
    values += 1;
    if (values > MAX_VALIDATION_PLAN_VALUES) {
      throw new TypeError(
        `[fluxfast] Invalid validation plan at ${frame.path}: plan contains more than ${MAX_VALIDATION_PLAN_VALUES} JSON values`
      );
    }
    const item = frame.value;
    if (
      item === null ||
      typeof item === "string" ||
      typeof item === "boolean"
    ) {
      if (
        typeof item === "string" &&
        item.length > MAX_VALIDATION_PLAN_STRING_LENGTH
      ) {
        throw new TypeError(
          `[fluxfast] Invalid validation plan at ${frame.path}: string exceeds the maximum length of ${MAX_VALIDATION_PLAN_STRING_LENGTH}`
        );
      }
      continue;
    }
    if (typeof item === "number") {
      if (!Number.isFinite(item)) {
        throw new TypeError(
          `[fluxfast] Invalid validation plan at ${frame.path}: plan values must be finite numbers`
        );
      }
      continue;
    }
    if (typeof item !== "object") {
      throw new TypeError(
        `[fluxfast] Invalid validation plan at ${frame.path}: plan values must be JSON-compatible`
      );
    }
    if (frame.depth > MAX_VALIDATION_PLAN_DEPTH) {
      throw new TypeError(
        `[fluxfast] Invalid validation plan at ${frame.path}: plan values exceed the maximum nesting depth of ${MAX_VALIDATION_PLAN_DEPTH}`
      );
    }
    if (active.has(item)) {
      throw new TypeError(
        `[fluxfast] Invalid validation plan at ${frame.path}: plan values cannot be circular`
      );
    }
    if (visited.has(item)) continue;
    visited.add(item);
    active.add(item);
    pending.push({ value: item, path: frame.path, depth: frame.depth, exit: true });

    if (safeIsArray(item)) {
      let length: number;
      try {
        length = item.length;
      } catch {
        throw new TypeError(
          `[fluxfast] Invalid validation plan at ${frame.path}: plan array length could not be read`
        );
      }
      if (!Number.isSafeInteger(length) || length < 0) {
        throw new TypeError(
          `[fluxfast] Invalid validation plan at ${frame.path}: plan array length must be a non-negative integer`
        );
      }
      if (length > MAX_VALIDATION_PLAN_CHILDREN) {
        throw new TypeError(
          `[fluxfast] Invalid validation plan at ${frame.path}: plan arrays contain more than ${MAX_VALIDATION_PLAN_CHILDREN} entries`
        );
      }
      for (let index = length - 1; index >= 0; index -= 1) {
        let child: unknown;
        try {
          child = item[index];
        } catch {
          throw new TypeError(
            `[fluxfast] Invalid validation plan at ${frame.path}[${index}]: value could not be read`
          );
        }
        pending.push({
          value: child,
          path: `${frame.path}[${index}]`,
          depth: frame.depth + 1
        });
      }
      continue;
    }

    const record = requireRecord(item, frame.path);
    let keys: string[];
    try {
      keys = Object.keys(record);
    } catch {
      throw new TypeError(
        `[fluxfast] Invalid validation plan at ${frame.path}: plan object properties could not be enumerated`
      );
    }
    if (keys.length > MAX_VALIDATION_PLAN_CHILDREN) {
      throw new TypeError(
        `[fluxfast] Invalid validation plan at ${frame.path}: plan objects contain more than ${MAX_VALIDATION_PLAN_CHILDREN} properties`
      );
    }
    for (let index = keys.length - 1; index >= 0; index -= 1) {
      const key = keys[index];
      let child: unknown;
      try {
        child = record[key];
      } catch {
        throw new TypeError(
          `[fluxfast] Invalid validation plan at ${pathKey(frame.path, key)}: value could not be read`
        );
      }
      pending.push({
        value: child,
        path: pathKey(frame.path, key),
        depth: frame.depth + 1
      });
    }
  }
}

function validateLimits(options: ValidationOptions = {}): NormalizedLimits {
  const maxDepth = options.maxDepth ?? options.limits?.maxDepth ?? DEFAULT_VALIDATION_MAX_DEPTH;
  const maxIssues = options.maxIssues ?? options.limits?.maxIssues ?? DEFAULT_VALIDATION_MAX_ISSUES;
  const maxOperations = options.maxOperations ?? options.limits?.maxOperations ?? DEFAULT_VALIDATION_MAX_OPERATIONS;
  const maxProperties = options.maxProperties ?? options.limits?.maxProperties ?? DEFAULT_VALIDATION_MAX_PROPERTIES;
  if (typeof maxDepth !== "number" || !Number.isSafeInteger(maxDepth) || maxDepth < 0) {
    throw new TypeError("[fluxfast] maxDepth must be a non-negative integer");
  }
  if (typeof maxIssues !== "number" || !Number.isSafeInteger(maxIssues) || maxIssues < 1) {
    throw new TypeError("[fluxfast] maxIssues must be a positive integer");
  }
  if (
    typeof maxOperations !== "number" ||
    !Number.isSafeInteger(maxOperations) ||
    maxOperations < 1
  ) {
    throw new TypeError("[fluxfast] maxOperations must be a positive integer");
  }
  if (
    typeof maxProperties !== "number" ||
    !Number.isSafeInteger(maxProperties) ||
    maxProperties < 1
  ) {
    throw new TypeError("[fluxfast] maxProperties must be a positive integer");
  }
  return { maxDepth, maxIssues, maxOperations, maxProperties };
}

function registerDefinitions(
  target: Map<string, ValidationPlan>,
  value: unknown,
  path: string
): void {
  const definitions = requireRecord(value, path);
  for (const name of Object.keys(definitions).sort()) {
    const definition = definitions[name];
    if (target.has(name) && target.get(name) !== definition) {
      throw new TypeError(
        `[fluxfast] Invalid validation plan at ${pathKey(path, name)}: duplicate definition`
      );
    }
    target.set(name, definition as ValidationPlan);
  }
}

function allowedKeys(kind: string): readonly string[] {
  const common = [
    "kind",
    "nullable",
    "optional",
    "definitions",
    "title",
    "description",
    "examples"
  ];
  switch (kind) {
    case "any":
    case "never":
    case "null":
    case "boolean":
    case "ref":
      return kind === "ref" ? [...common, "name", "ref"] : common;
    case "string":
      return [...common, "minLength", "maxLength", "pattern", "format"];
    case "number":
    case "integer":
      return [
        ...common,
        "minimum",
        "maximum",
        "exclusiveMinimum",
        "exclusiveMaximum",
        "multipleOf"
      ];
    case "literal":
      return [...common, "value"];
    case "enum":
      return [...common, "values"];
    case "array":
      return [...common, "items", "prefixItems", "minItems", "maxItems"];
    case "tuple":
      return [...common, "items", "rest"];
    case "object":
      return [...common, "properties", "required", "additionalProperties"];
    case "union":
      return [...common, "anyOf", "oneOf"];
    case "oneOf":
      return [...common, "anyOf"];
    case "intersection":
      return [...common, "allOf"];
    default:
      return common;
  }
}

function assertKnownKeys(plan: Record<string, unknown>, path: string): void {
  const allowed = new Set(allowedKeys(String(plan.kind)));
  for (const key of Object.keys(plan)) {
    if (!allowed.has(key)) {
      throw new TypeError(
        `[fluxfast] Unsupported validation plan field at ${pathKey(path, key)}`
      );
    }
  }
}

function validateCommonFields(plan: Record<string, unknown>, path: string): void {
  if (plan.nullable !== undefined) requireBoolean(plan.nullable, `${path}.nullable`);
  if (plan.optional !== undefined) requireBoolean(plan.optional, `${path}.optional`);
  if (plan.definitions !== undefined) requireRecord(plan.definitions, `${path}.definitions`);
  if (plan.title !== undefined && typeof plan.title !== "string") {
    throw new TypeError(`[fluxfast] Invalid validation plan at ${path}.title`);
  }
  if (plan.description !== undefined && typeof plan.description !== "string") {
    throw new TypeError(`[fluxfast] Invalid validation plan at ${path}.description`);
  }
  if (plan.examples !== undefined) requireArray(plan.examples, `${path}.examples`);
}

function validateNumberFields(plan: Record<string, unknown>, path: string): void {
  for (const key of [
    "minimum",
    "maximum",
    "exclusiveMinimum",
    "exclusiveMaximum"
  ]) {
    if (plan[key] !== undefined) requireFiniteNumber(plan[key], `${path}.${key}`);
  }
  if (plan.multipleOf !== undefined) {
    requireFiniteNumber(plan.multipleOf, `${path}.multipleOf`);
    if ((plan.multipleOf as number) <= 0) {
      throw new TypeError(`[fluxfast] ${path}.multipleOf must be greater than zero`);
    }
  }
}

function validateNestedPlan(
  value: unknown,
  path: string,
  visit: (value: ValidationPlan, path: string) => void
): void {
  if (typeof value === "boolean") return;
  visit(value as ValidationPlan, path);
}

function validateNode(
  value: ValidationPlan,
  path: string,
  visit: (value: ValidationPlan, path: string) => void,
  patterns: WeakMap<object, RegExp>
): void {
  if (typeof value === "boolean") return;
  const plan = requireRecord(value, path);
  const kind = requireNonEmptyString(plan.kind, `${path}.kind`);
  assertKnownKeys(plan, path);
  validateCommonFields(plan, path);

  switch (kind) {
    case "any":
    case "never":
    case "null":
    case "boolean":
      break;
    case "string": {
      for (const key of ["minLength", "maxLength"]) {
        if (plan[key] !== undefined) requireNonNegativeInteger(plan[key], `${path}.${key}`);
      }
      if (
        plan.minLength !== undefined &&
        plan.maxLength !== undefined &&
        (plan.minLength as number) > (plan.maxLength as number)
      ) {
        throw new TypeError(`[fluxfast] ${path}.minLength cannot exceed maxLength`);
      }
      if (plan.pattern !== undefined) {
        const pattern = requireString(plan.pattern, `${path}.pattern`);
        const patternError = validationPatternError(pattern);
        if (patternError !== undefined) {
          throw new TypeError(
            `[fluxfast] Invalid validation pattern at ${path}.pattern: ${patternError}`
          );
        }
        try {
          patterns.set(value as object, new RegExp(pattern, "u"));
        } catch (error) {
          throw new TypeError(
            `[fluxfast] Invalid regular expression at ${path}.pattern: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        }
      }
      if (plan.format !== undefined) {
        const format = requireNonEmptyString(plan.format, `${path}.format`);
        if (!isSupportedValidationFormat(format)) {
          throw new TypeError(
            `[fluxfast] Unsupported validation format ${JSON.stringify(format)} at ${path}.format`
          );
        }
      }
      break;
    }
    case "number":
    case "integer":
      validateNumberFields(plan, path);
      break;
    case "literal":
      if (!("value" in plan)) {
        throw new TypeError(`[fluxfast] Invalid validation plan at ${path}.value`);
      }
      break;
    case "enum": {
      const values = requireArray(plan.values, `${path}.values`);
      if (values.length === 0) {
        throw new TypeError(`[fluxfast] ${path}.values must not be empty`);
      }
      break;
    }
    case "array": {
      if (plan.items !== undefined) validateNestedPlan(plan.items, `${path}.items`, visit);
      if (plan.prefixItems !== undefined) {
        const prefixItems = requireArray(plan.prefixItems, `${path}.prefixItems`);
        prefixItems.forEach((item, index) =>
          validateNestedPlan(item, `${path}.prefixItems[${index}]`, visit)
        );
      }
      for (const key of ["minItems", "maxItems"]) {
        if (plan[key] !== undefined) requireNonNegativeInteger(plan[key], `${path}.${key}`);
      }
      if (
        plan.minItems !== undefined &&
        plan.maxItems !== undefined &&
        (plan.minItems as number) > (plan.maxItems as number)
      ) {
        throw new TypeError(`[fluxfast] ${path}.minItems cannot exceed maxItems`);
      }
      break;
    }
    case "tuple": {
      const items = requireArray(plan.items, `${path}.items`);
      items.forEach((item, index) =>
        validateNestedPlan(item, `${path}.items[${index}]`, visit)
      );
      if (plan.rest !== undefined && plan.rest !== false) {
        validateNestedPlan(plan.rest, `${path}.rest`, visit);
      }
      break;
    }
    case "object": {
      if (plan.properties !== undefined) {
        const properties = requireRecord(plan.properties, `${path}.properties`);
        for (const key of Object.keys(properties).sort()) {
          validateNestedPlan(properties[key], pathKey(`${path}.properties`, key), visit);
        }
      }
      if (plan.required !== undefined) {
        const required = requireArray(plan.required, `${path}.required`);
        const seen = new Set<string>();
        required.forEach((item, index) => {
          const name = requireString(item, `${path}.required[${index}]`);
          if (seen.has(name)) {
            throw new TypeError(`[fluxfast] ${path}.required duplicates ${JSON.stringify(name)}`);
          }
          seen.add(name);
        });
      }
      if (plan.additionalProperties !== undefined) {
        validateNestedPlan(
          plan.additionalProperties,
          `${path}.additionalProperties`,
          visit
        );
      }
      break;
    }
    case "union":
    case "oneOf": {
      const branches = requireArray(plan.anyOf, `${path}.anyOf`);
      if (branches.length === 0) {
        throw new TypeError(`[fluxfast] ${path}.anyOf must not be empty`);
      }
      branches.forEach((item, index) =>
        validateNestedPlan(item, `${path}.anyOf[${index}]`, visit)
      );
      if (kind === "union" && plan.oneOf !== undefined) {
        requireBoolean(plan.oneOf, `${path}.oneOf`);
      }
      break;
    }
    case "intersection": {
      const branches = requireArray(plan.allOf, `${path}.allOf`);
      branches.forEach((item, index) =>
        validateNestedPlan(item, `${path}.allOf[${index}]`, visit)
      );
      break;
    }
    case "ref": {
      const hasName = plan.name !== undefined;
      const hasRef = plan.ref !== undefined;
      if (hasName === hasRef) {
        throw new TypeError(`[fluxfast] ${path} must contain exactly one of name or ref`);
      }
      requireNonEmptyString(
        hasName ? plan.name : plan.ref,
        `${path}.${hasName ? "name" : "ref"}`
      );
      break;
    }
    default:
      throw new TypeError(
        `[fluxfast] Unsupported validation plan kind ${JSON.stringify(kind)} at ${path}.kind`
      );
  }

  if (plan.definitions !== undefined) {
    const definitions = requireRecord(plan.definitions, `${path}.definitions`);
    for (const name of Object.keys(definitions).sort()) {
      requireNonEmptyString(name, pathKey(`${path}.definitions`, name));
      validateNestedPlan(
        definitions[name],
        pathKey(`${path}.definitions`, name),
        visit
      );
    }
  }
}

function collectAndValidate(
  root: ValidationPlan,
  documentDefinitions: unknown,
  patterns: WeakMap<object, RegExp>
): Map<string, ValidationPlan> {
  assertPlanBounds(root, documentDefinitions);
  const definitions = new Map<string, ValidationPlan>();
  if (documentDefinitions !== undefined) {
    registerDefinitions(definitions, documentDefinitions, "$.definitions");
  }
  const visited = new WeakSet<object>();
  const visiting = new WeakSet<object>();
  interface WorkItem {
    readonly value: ValidationPlan;
    readonly path: string;
    readonly exit?: boolean;
  }
  const pending: WorkItem[] = [{ value: root, path: "$" }];
  const enqueue = (value: ValidationPlan, path: string): void => {
    pending.push({ value, path });
  };

  const drain = (): void => {
    while (pending.length > 0) {
      const item = pending.pop()!;
      if (item.exit) {
        if (typeof item.value !== "boolean") {
          const object = requireRecord(item.value, item.path);
          visiting.delete(object);
          visited.add(object);
        }
        continue;
      }
      if (typeof item.value === "boolean") continue;
      const object = requireRecord(item.value, item.path);
      if (visiting.has(object)) {
        throw new TypeError(`[fluxfast] Circular validation plan at ${item.path}`);
      }
      if (visited.has(object)) continue;
      visiting.add(object);
      pending.push({ value: item.value, path: item.path, exit: true });
      if (object.definitions !== undefined) {
        registerDefinitions(definitions, object.definitions, `${item.path}.definitions`);
      }
      validateNode(item.value, item.path, enqueue, patterns);
    }
  };

  drain();
  const scheduledDefinitions = new Set<string>();
  while (true) {
    let scheduled = false;
    for (const [name, definition] of [...definitions.entries()].sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0
    )) {
      if (scheduledDefinitions.has(name)) continue;
      scheduledDefinitions.add(name);
      enqueue(definition, `$.definitions[${JSON.stringify(name)}]`);
      scheduled = true;
    }
    if (!scheduled) break;
    drain();
  }
  return definitions;
}

/** Validate and precompile a static plan before it is used at runtime. */
export function compileValidationPlan(
  input: ValidationPlan | ValidationPlanDocument,
  options: ValidationOptions = {}
): CompiledValidationPlan {
  const root = isValidationPlanDocument(input) ? input.root : input;
  const documentDefinitions = isValidationPlanDocument(input)
    ? input.definitions
    : undefined;
  const patterns = new WeakMap<object, RegExp>();
  const definitions = collectAndValidate(root, documentDefinitions, patterns);
  return {
    root,
    definitions,
    patterns,
    limits: validateLimits(options)
  };
}

class IssueCollector {
  readonly issues: ValidationIssue[] = [];

  constructor(private readonly maxIssues: number) {}

  add(path: readonly (string | number)[], code: string, message: string): void {
    if (this.issues.length >= this.maxIssues) return;
    this.issues.push(createValidationIssue(path, code, message));
  }
}

interface RefFrame {
  readonly name: string;
  readonly value: unknown;
}

interface EvaluationState {
  readonly compiled: CompiledValidationPlan;
  collector: IssueCollector;
  readonly primaryCollector: IssueCollector;
  readonly activeValues: WeakSet<object>;
  readonly refs: RefFrame[];
  readonly root: ValidationPlan;
  operations: number;
  operationLimitReported: boolean;
}

function withCollector<T>(
  state: EvaluationState,
  collector: IssueCollector,
  callback: () => T
): T {
  const previous = state.collector;
  state.collector = collector;
  try {
    return callback();
  } finally {
    state.collector = previous;
  }
}

function isObjectLike(value: unknown): value is object {
  return value !== null && typeof value === "object";
}

function safeIsArray(value: unknown): value is unknown[] {
  try {
    return Array.isArray(value);
  } catch {
    return false;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!isObjectLike(value) || safeIsArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function expectedType(value: unknown): string {
  if (value === null) return "null";
  if (safeIsArray(value)) return "array";
  return typeof value;
}

function consumeOperation(
  state: EvaluationState,
  path: readonly (string | number)[]
): boolean {
  if (state.operations >= state.compiled.limits.maxOperations) {
    if (!state.operationLimitReported) {
      state.operationLimitReported = true;
      state.primaryCollector.add(
        path,
        "maxOperations",
        "Validation operation limit exceeded."
      );
    }
    return false;
  }
  state.operations += 1;
  return true;
}

function addTypeIssue(
  state: EvaluationState,
  path: readonly (string | number)[],
  expected: string,
  value: unknown
): void {
  state.collector.add(
    path,
    "type",
    `Expected ${expected}; received ${expectedType(value)}.`
  );
}

function enterValue(
  state: EvaluationState,
  value: object,
  path: readonly (string | number)[]
): boolean {
  if (state.activeValues.has(value)) {
    state.collector.add(path, "cycle", "Cyclic value encountered during validation.");
    return false;
  }
  state.activeValues.add(value);
  return true;
}

function readOwnValue(
  value: Record<string, unknown>,
  key: string
): { found: boolean; value?: unknown; threw?: boolean } {
  try {
    if (!Object.prototype.hasOwnProperty.call(value, key)) return { found: false };
    return { found: true, value: value[key] };
  } catch {
    return { found: true, threw: true };
  }
}

function hasOwnValue(value: Record<string, unknown>, key: string): boolean | undefined {
  try {
    return Object.prototype.hasOwnProperty.call(value, key);
  } catch {
    return undefined;
  }
}

function readArrayLength(value: unknown[], path: readonly (string | number)[], state: EvaluationState): number | undefined {
  try {
    const length = value.length;
    if (!Number.isSafeInteger(length) || length < 0) {
      state.collector.add(path, "read", "Array length could not be read.");
      return undefined;
    }
    return length;
  } catch {
    state.collector.add(path, "read", "Array length could not be read.");
    return undefined;
  }
}

function readArrayValue(
  value: unknown[],
  index: number
): { value?: unknown; threw?: boolean } {
  try {
    return { value: value[index] };
  } catch {
    return { threw: true };
  }
}

interface ReadKeysResult {
  readonly keys?: string[];
  readonly error?: "read" | "maxProperties" | "maxOperations";
}

function readKeys(
  value: Record<string, unknown>,
  state: EvaluationState,
  path: readonly (string | number)[]
): ReadKeysResult {
  if (!consumeOperation(state, path)) return { error: "maxOperations" };
  const keys: string[] = [];
  try {
    for (const key in value) {
      const own = hasOwnValue(value, key);
      if (own === undefined) return { error: "read" };
      if (!own) continue;
      if (!consumeOperation(state, [...path, key])) {
        return { error: "maxOperations" };
      }
      keys.push(key);
      if (keys.length > state.compiled.limits.maxProperties) {
        state.collector.add(
          path,
          "maxProperties",
          `Object contains more than ${state.compiled.limits.maxProperties} properties.`
        );
        return { error: "maxProperties" };
      }
    }
    return { keys: keys.sort() };
  } catch {
    return { error: "read" };
  }
}

interface EqualPair {
  readonly left: unknown;
  readonly right: unknown;
  readonly path: readonly (string | number)[];
}

function deepEqual(
  left: unknown,
  right: unknown,
  state: EvaluationState,
  path: readonly (string | number)[]
): boolean {
  const seen = new Map<object, object>();
  const pending: EqualPair[] = [{ left, right, path }];
  while (pending.length > 0) {
    const pair = pending.pop()!;
    if (!consumeOperation(state, pair.path)) return false;
    if (Object.is(pair.left, pair.right)) continue;
    if (!isObjectLike(pair.left) || !isObjectLike(pair.right)) return false;

    const leftArray = safeIsArray(pair.left);
    const rightArray = safeIsArray(pair.right);
    if (leftArray !== rightArray) return false;
    const previous = seen.get(pair.left);
    if (previous !== undefined) {
      if (previous !== pair.right) return false;
      continue;
    }
    seen.set(pair.left, pair.right);

    if (leftArray && rightArray) {
      let leftLength: number;
      let rightLength: number;
      if (!consumeOperation(state, pair.path)) return false;
      try {
        leftLength = (pair.left as unknown[]).length;
        rightLength = (pair.right as unknown[]).length;
      } catch {
        return false;
      }
      if (
        !Number.isSafeInteger(leftLength) ||
        !Number.isSafeInteger(rightLength) ||
        leftLength < 0 ||
        rightLength < 0
      ) {
        return false;
      }
      if (
        leftLength > state.compiled.limits.maxProperties ||
        rightLength > state.compiled.limits.maxProperties
      ) {
        state.collector.add(
          pair.path,
          "maxProperties",
          `Collection contains more than ${state.compiled.limits.maxProperties} items.`
        );
        return false;
      }
      if (leftLength !== rightLength) return false;
      for (let index = leftLength - 1; index >= 0; index -= 1) {
        const itemPath = [...pair.path, index];
        if (!consumeOperation(state, itemPath)) return false;
        let leftValue: unknown;
        let rightValue: unknown;
        try {
          leftValue = (pair.left as unknown[])[index];
          rightValue = (pair.right as unknown[])[index];
        } catch {
          return false;
        }
        pending.push({ left: leftValue, right: rightValue, path: itemPath });
      }
      continue;
    }

    if (!isPlainObject(pair.left) || !isPlainObject(pair.right)) return false;
    const leftKeys = readKeys(pair.left, state, pair.path);
    const rightKeys = readKeys(pair.right, state, pair.path);
    if (
      !leftKeys.keys ||
      !rightKeys.keys ||
      leftKeys.keys.length !== rightKeys.keys.length
    ) {
      return false;
    }
    for (let index = leftKeys.keys.length - 1; index >= 0; index -= 1) {
      const leftKey = leftKeys.keys[index];
      if (leftKey !== rightKeys.keys[index]) return false;
      const itemPath = [...pair.path, leftKey];
      if (!consumeOperation(state, itemPath)) return false;
      const leftValue = readOwnValue(pair.left, leftKey);
      const rightValue = readOwnValue(pair.right, leftKey);
      if (
        !leftValue.found ||
        !rightValue.found ||
        leftValue.threw ||
        rightValue.threw
      ) {
        return false;
      }
      pending.push({
        left: leftValue.value,
        right: rightValue.value,
        path: itemPath
      });
    }
  }
  return true;
}

function normalizeReference(reference: string): string {
  const prefix = ["#/$defs/", "#/definitions/"].find(item =>
    reference.startsWith(item)
  );
  if (!prefix) return reference;
  try {
    return decodeURIComponent(reference.slice(prefix.length))
      .replace(/~1/g, "/")
      .replace(/~0/g, "~");
  } catch {
    return reference;
  }
}

function sameReferenceValue(left: unknown, right: unknown): boolean {
  return isObjectLike(left) || isObjectLike(right)
    ? left === right
    : Object.is(left, right);
}

interface DecimalParts {
  readonly coefficient: bigint;
  readonly power: number;
}

function decimalParts(value: number): DecimalParts {
  const source = value.toString().toLowerCase();
  const [mantissa, exponentText] = source.split("e");
  const exponent = exponentText === undefined ? 0 : Number(exponentText);
  const negative = mantissa.startsWith("-");
  const unsigned = negative || mantissa.startsWith("+")
    ? mantissa.slice(1)
    : mantissa;
  const dot = unsigned.indexOf(".");
  const fractionalDigits = dot === -1 ? 0 : unsigned.length - dot - 1;
  const digits = (dot === -1 ? unsigned : unsigned.replace(".", ""));
  return {
    coefficient: BigInt((negative ? "-" : "") + digits),
    power: exponent - fractionalDigits
  };
}

function isMultipleOf(value: number, multipleOf: number): boolean {
  if (Number.isSafeInteger(value) && Number.isSafeInteger(multipleOf)) {
    return value % multipleOf === 0;
  }
  const left = decimalParts(value);
  const right = decimalParts(multipleOf);
  const difference = left.power - right.power;
  const numerator = difference >= 0
    ? left.coefficient * 10n ** BigInt(difference)
    : left.coefficient;
  const denominator = difference >= 0
    ? right.coefficient
    : right.coefficient * 10n ** BigInt(-difference);
  if (denominator === 0n) return false;
  if (numerator % denominator === 0n) return true;

  // Pydantic's float validator allows the tiny rounding error introduced by
  // ordinary decimal arithmetic (for example, 0.1 + 0.2). Keep that
  // compatibility without allowing a half-quotient error at large values.
  const quotient = value / multipleOf;
  const nearest = Math.round(quotient);
  const differenceFromInteger = Math.abs(quotient - nearest);
  const floatingTolerance = Math.min(
    1e-7,
    Number.EPSILON * Math.max(1, Math.abs(quotient)) * 8
  );
  return differenceFromInteger <= floatingTolerance;
}

function evaluateNumber(
  plan: Extract<ValidationNode, { kind: "number" | "integer" }>,
  value: unknown,
  path: readonly (string | number)[],
  state: EvaluationState
): boolean {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    (plan.kind === "integer" && !Number.isInteger(value))
  ) {
    addTypeIssue(state, path, plan.kind, value);
    return false;
  }
  let valid = true;
  if (plan.minimum !== undefined && value < plan.minimum) {
    state.collector.add(path, "minimum", `Value must be at least ${plan.minimum}.`);
    valid = false;
  }
  if (plan.maximum !== undefined && value > plan.maximum) {
    state.collector.add(path, "maximum", `Value must be at most ${plan.maximum}.`);
    valid = false;
  }
  if (plan.exclusiveMinimum !== undefined && value <= plan.exclusiveMinimum) {
    state.collector.add(
      path,
      "exclusiveMinimum",
      `Value must be greater than ${plan.exclusiveMinimum}.`
    );
    valid = false;
  }
  if (plan.exclusiveMaximum !== undefined && value >= plan.exclusiveMaximum) {
    state.collector.add(
      path,
      "exclusiveMaximum",
      `Value must be less than ${plan.exclusiveMaximum}.`
    );
    valid = false;
  }
  if (plan.multipleOf !== undefined) {
    if (!isMultipleOf(value, plan.multipleOf)) {
      state.collector.add(
        path,
        "multipleOf",
        `Value must be a multiple of ${plan.multipleOf}.`
      );
      valid = false;
    }
  }
  return valid;
}

function evaluateString(
  plan: ValidationStringPlan,
  value: unknown,
  path: readonly (string | number)[],
  state: EvaluationState
): boolean {
  if (typeof value !== "string") {
    addTypeIssue(state, path, "string", value);
    return false;
  }
  let length = 0;
  for (const _character of value) {
    if (!consumeOperation(state, path)) return false;
    length += 1;
  }
  let valid = true;
  if (plan.minLength !== undefined && length < plan.minLength) {
    state.collector.add(path, "minLength", `String must contain at least ${plan.minLength} characters.`);
    valid = false;
  }
  if (plan.maxLength !== undefined && length > plan.maxLength) {
    state.collector.add(path, "maxLength", `String must contain at most ${plan.maxLength} characters.`);
    valid = false;
  }
  if (plan.pattern !== undefined) {
    const pattern = state.compiled.patterns.get(plan as object);
    if (!pattern) {
      state.collector.add(path, "pattern", "Pattern could not be evaluated.");
      valid = false;
    } else {
      pattern.lastIndex = 0;
      if (!pattern.test(value)) {
        state.collector.add(path, "pattern", "String does not match the required pattern.");
        valid = false;
      }
    }
  }
  if (
    plan.format !== undefined &&
    !validateValidationFormat(value, plan.format as ValidationFormat)
  ) {
    state.collector.add(path, "format", `String does not match the ${plan.format} format.`);
    valid = false;
  }
  return valid;
}

function evaluateObject(
  plan: ValidationObjectPlan,
  value: unknown,
  path: readonly (string | number)[],
  depth: number,
  state: EvaluationState
): boolean {
  if (!isPlainObject(value)) {
    addTypeIssue(state, path, "object", value);
    return false;
  }
  if (!enterValue(state, value, path)) return false;
  try {
    const properties = plan.properties ?? {};
    const propertyNames = Object.keys(properties).sort();
    const required = [...(plan.required ?? [])].sort();
    let valid = true;
    for (const key of required) {
      if (!consumeOperation(state, [...path, key])) {
        valid = false;
        break;
      }
      const present = hasOwnValue(value, key);
      if (present === undefined) {
        state.collector.add([...path, key], "read", "Property could not be inspected.");
        valid = false;
        continue;
      }
      if (!present) {
        state.collector.add(
          [...path, key],
          "required",
          `Required property ${displayValidationKey(key)} is missing.`
        );
        valid = false;
      }
    }
    for (const key of propertyNames) {
      if (!consumeOperation(state, [...path, key])) {
        valid = false;
        break;
      }
      const read = readOwnValue(value, key);
      if (!read.found) continue;
      if (read.threw) {
        state.collector.add([...path, key], "read", "Property could not be read.");
        valid = false;
        continue;
      }
      if (!evaluate(properties[key], read.value, [...path, key], depth + 1, state)) {
        valid = false;
      }
    }

    const additional = plan.additionalProperties;
    if (additional !== undefined && additional !== true) {
      const keysResult = readKeys(value, state, path);
      if (!keysResult.keys) {
        if (keysResult.error === "maxProperties" || keysResult.error === "maxOperations") {
          return false;
        }
        state.collector.add(path, "read", "Object properties could not be enumerated.");
        return false;
      }
      const declared = new Set(propertyNames);
      for (const key of keysResult.keys) {
        if (declared.has(key)) continue;
        if (additional === false) {
          state.collector.add(
            [...path, key],
            "additionalProperties",
            `Additional property ${displayValidationKey(key)} is not allowed.`
          );
          valid = false;
          continue;
        }
        const read = readOwnValue(value, key);
        if (!read.found || read.threw) {
          state.collector.add([...path, key], "read", "Property could not be read.");
          valid = false;
          continue;
        }
        if (!evaluate(additional, read.value, [...path, key], depth + 1, state)) {
          valid = false;
        }
      }
    }
    return valid;
  } finally {
    state.activeValues.delete(value);
  }
}

function evaluateArray(
  plan: ValidationArrayPlan,
  value: unknown,
  path: readonly (string | number)[],
  depth: number,
  state: EvaluationState
): boolean {
  if (!safeIsArray(value)) {
    addTypeIssue(state, path, "array", value);
    return false;
  }
  if (!enterValue(state, value, path)) return false;
  try {
    const length = readArrayLength(value, path, state);
    if (length === undefined) return false;
    let valid = true;
    if (plan.minItems !== undefined && length < plan.minItems) {
      state.collector.add(path, "minItems", `Array must contain at least ${plan.minItems} items.`);
      valid = false;
    }
    if (plan.maxItems !== undefined && length > plan.maxItems) {
      state.collector.add(path, "maxItems", `Array must contain at most ${plan.maxItems} items.`);
      valid = false;
    }
    const prefixItems = plan.prefixItems ?? [];
    for (let index = 0; index < Math.min(length, prefixItems.length); index += 1) {
      const itemPath = [...path, index];
      if (!consumeOperation(state, itemPath)) {
        valid = false;
        break;
      }
      const read = readArrayValue(value, index);
      if (read.threw) {
        state.collector.add(itemPath, "read", "Array item could not be read.");
        valid = false;
        continue;
      }
      if (!evaluate(prefixItems[index], read.value, itemPath, depth + 1, state)) {
        valid = false;
      }
    }
    for (let index = prefixItems.length; index < length; index += 1) {
      const itemPath = [...path, index];
      if (!consumeOperation(state, itemPath)) {
        valid = false;
        break;
      }
      const itemPlan = plan.items;
      if (itemPlan === false) {
        state.collector.add(itemPath, "items", "Additional array items are not allowed.");
        valid = false;
      } else if (itemPlan !== undefined && itemPlan !== true) {
        const read = readArrayValue(value, index);
        if (read.threw) {
          state.collector.add(itemPath, "read", "Array item could not be read.");
          valid = false;
        } else if (!evaluate(itemPlan, read.value, itemPath, depth + 1, state)) {
          valid = false;
        }
      }
    }
    return valid;
  } finally {
    state.activeValues.delete(value);
  }
}

function evaluateTuple(
  plan: ValidationTuplePlan,
  value: unknown,
  path: readonly (string | number)[],
  depth: number,
  state: EvaluationState
): boolean {
  if (!safeIsArray(value)) {
    addTypeIssue(state, path, "array", value);
    return false;
  }
  if (!enterValue(state, value, path)) return false;
  try {
    const length = readArrayLength(value, path, state);
    if (length === undefined) return false;
    let valid = true;
    for (let index = 0; index < plan.items.length; index += 1) {
      const itemPath = [...path, index];
      if (!consumeOperation(state, itemPath)) {
        valid = false;
        break;
      }
      if (index >= length) {
        state.collector.add([...path, index], "required", "Tuple item is missing.");
        valid = false;
      } else {
        const read = readArrayValue(value, index);
        if (read.threw) {
          state.collector.add(itemPath, "read", "Array item could not be read.");
          valid = false;
        } else if (!evaluate(plan.items[index], read.value, itemPath, depth + 1, state)) {
          valid = false;
        }
      }
    }
    if (length > plan.items.length) {
      if (plan.rest === false || plan.rest === undefined) {
        state.collector.add(
          [...path, plan.items.length],
          "tuple",
          "Tuple contains more items than expected."
        );
        valid = false;
      } else {
        for (let index = plan.items.length; index < length; index += 1) {
          const itemPath = [...path, index];
          if (!consumeOperation(state, itemPath)) {
            valid = false;
            break;
          }
          const read = readArrayValue(value, index);
          if (read.threw) {
            state.collector.add(itemPath, "read", "Array item could not be read.");
            valid = false;
          } else if (!evaluate(plan.rest, read.value, itemPath, depth + 1, state)) {
            valid = false;
          }
        }
      }
    }
    return valid;
  } finally {
    state.activeValues.delete(value);
  }
}

function evaluateUnion(
  plan: ValidationUnionPlan | ValidationOneOfPlan,
  value: unknown,
  path: readonly (string | number)[],
  depth: number,
  state: EvaluationState,
  oneOf: boolean
): boolean {
  let matches = 0;
  for (const branch of plan.anyOf) {
    if (!consumeOperation(state, path)) break;
    const branchCollector = new IssueCollector(1);
    const branchValid = withCollector(state, branchCollector, () =>
      evaluate(branch, value, path, depth + 1, state)
    );
    if (branchValid) matches += 1;
  }
  if ((!oneOf && matches > 0) || (oneOf && matches === 1)) return true;
  state.collector.add(
    path,
    oneOf ? "oneOf" : "union",
    oneOf
      ? matches === 0
        ? "Value must match exactly one schema."
        : "Value matches more than one schema."
      : "Value must match at least one schema."
  );
  return false;
}

function evaluateIntersection(
  plan: ValidationIntersectionPlan,
  value: unknown,
  path: readonly (string | number)[],
  depth: number,
  state: EvaluationState
): boolean {
  let valid = true;
  for (const branch of plan.allOf) {
    if (!consumeOperation(state, path)) {
      valid = false;
      break;
    }
    if (!evaluate(branch, value, path, depth + 1, state)) valid = false;
  }
  return valid;
}

function evaluateReference(
  plan: ValidationRefPlan,
  value: unknown,
  path: readonly (string | number)[],
  depth: number,
  state: EvaluationState
): boolean {
  if (!consumeOperation(state, path)) return false;
  const reference = normalizeReference(plan.name ?? plan.ref!);
  const target = reference === "#" ? state.root : state.compiled.definitions.get(reference);
  if (target === undefined) {
    state.collector.add(path, "ref", `Unknown validation reference ${JSON.stringify(reference)}.`);
    return false;
  }
  if (state.refs.some(frame => frame.name === reference && sameReferenceValue(frame.value, value))) {
    state.collector.add(
      path,
      isObjectLike(value) && state.activeValues.has(value) ? "cycle" : "refCycle",
      isObjectLike(value) && state.activeValues.has(value)
        ? "Cyclic value encountered during validation."
        : "Validation reference cycle did not consume a nested value."
    );
    return false;
  }
  state.refs.push({ name: reference, value });
  try {
    return evaluate(target, value, path, depth + 1, state);
  } finally {
    state.refs.pop();
  }
}

function evaluate(
  plan: ValidationPlan,
  value: unknown,
  path: readonly (string | number)[],
  depth: number,
  state: EvaluationState
): boolean {
  if (!consumeOperation(state, path)) return false;
  if (typeof plan === "boolean") {
    if (!plan) state.collector.add(path, "never", "Value is not allowed.");
    return plan;
  }
  if (plan.optional && value === undefined) return true;
  if (plan.nullable && value === null) return true;
  if (depth > state.compiled.limits.maxDepth) {
    state.collector.add(path, "maxDepth", "Validation depth limit exceeded.");
    return false;
  }

  switch (plan.kind) {
    case "any":
      return true;
    case "never":
      state.collector.add(path, "never", "Value is not allowed.");
      return false;
    case "null":
      if (value === null) return true;
      addTypeIssue(state, path, "null", value);
      return false;
    case "boolean":
      if (typeof value === "boolean") return true;
      addTypeIssue(state, path, "boolean", value);
      return false;
    case "string":
      return evaluateString(plan, value, path, state);
    case "number":
    case "integer":
      return evaluateNumber(plan, value, path, state);
    case "literal":
      if (deepEqual(plan.value, value, state, path)) return true;
      state.collector.add(path, "const", "Value does not equal the required literal.");
      return false;
    case "enum":
      for (const candidate of plan.values) {
        if (!consumeOperation(state, path)) return false;
        if (deepEqual(candidate, value, state, path)) return true;
      }
      state.collector.add(path, "enum", "Value is not one of the allowed values.");
      return false;
    case "array":
      return evaluateArray(plan, value, path, depth, state);
    case "tuple":
      return evaluateTuple(plan, value, path, depth, state);
    case "object":
      return evaluateObject(plan, value, path, depth, state);
    case "union":
      return evaluateUnion(plan, value, path, depth, state, plan.oneOf === true);
    case "oneOf":
      return evaluateUnion(plan, value, path, depth, state, true);
    case "intersection":
      return evaluateIntersection(plan, value, path, depth, state);
    case "ref":
      return evaluateReference(plan, value, path, depth, state);
    default:
      state.collector.add(path, "plan", "Unsupported validation plan kind.");
      return false;
  }
}

/** Evaluate one compiled static validation plan without any framework dependency. */
export function evaluateValidationPlan<T>(
  compiled: CompiledValidationPlan,
  value: unknown
): ValidationResult<T> {
  const collector = new IssueCollector(compiled.limits.maxIssues);
  const state: EvaluationState = {
    compiled,
    collector,
    primaryCollector: collector,
    activeValues: new WeakSet<object>(),
    refs: [],
    root: compiled.root,
    operations: 0,
    operationLimitReported: false
  };
  const valid = evaluate(compiled.root, value, [], 0, state);
  if (valid) {
    return { valid: true, value: value as T, issues: [] };
  }
  return { valid: false, issues: Object.freeze([...collector.issues]) };
}

/** Convenience function for callers that already have a plan. */
export function validateWithPlan<T>(
  plan: ValidationPlan | ValidationPlanDocument,
  value: unknown,
  options: ValidationOptions = {}
): ValidationResult<T> {
  return evaluateValidationPlan<T>(compileValidationPlan(plan, options), value);
}
