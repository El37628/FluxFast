/** Runtime validation for the offline FluxFast developer schema manifest. */

export const FLUXFAST_SCHEMA_MANIFEST_V1 = "fluxfast-schema/1" as const;
export const FLUXFAST_SCHEMA_MANIFEST_V2 = "fluxfast-schema/2" as const;
// Preserve the v1 export for consumers that imported it before schema/2.
export const FLUXFAST_SCHEMA_MANIFEST_VERSION = FLUXFAST_SCHEMA_MANIFEST_V1;

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type JsonSchema = Record<string, JsonValue>;

export interface FluxFastResourceSchemaEntry {
  schema: JsonSchema;
}

export type FluxFastContractMode = "serialization" | "validation";

export interface FluxFastTypeSchemaEntry {
  mode: FluxFastContractMode;
  schema: JsonSchema;
}

export interface FluxFastRouteParameterSchema {
  name: string;
  location: "path" | "query";
  required: boolean;
  schema: JsonSchema;
}

export interface FluxFastPageRouteSchema {
  name: string;
  path: string;
  parameters: FluxFastRouteParameterSchema[];
}

export type FluxFastMutationMethod = "DELETE" | "PATCH" | "POST" | "PUT";

export interface FluxFastMutationRouteSchema {
  name: string;
  path: string;
  method: FluxFastMutationMethod;
  parameters: FluxFastRouteParameterSchema[];
  body?: JsonSchema | null;
}

export interface FluxFastSchemaManifest {
  schema: typeof FLUXFAST_SCHEMA_MANIFEST_V1 | typeof FLUXFAST_SCHEMA_MANIFEST_V2;
  producer: string;
  fingerprint: string;
  types?: Record<string, FluxFastTypeSchemaEntry>;
  resources: Record<string, FluxFastResourceSchemaEntry>;
  pages: FluxFastPageRouteSchema[];
  mutations: FluxFastMutationRouteSchema[];
}

/** A precise, user-facing error for an invalid schema manifest. */
export class SchemaManifestValidationError extends TypeError {
  readonly path: string;

  constructor(path: string, reason: string) {
    super(`[fluxfast] Invalid schema manifest at ${path}: ${reason}`);
    this.name = "SchemaManifestValidationError";
    this.path = path;
  }
}

const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;
const SEMVER_PATTERN = new RegExp(
  "^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)" +
    "(?:-[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?" +
    "(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$"
);
const MUTATION_METHODS = new Set<FluxFastMutationMethod>([
  "DELETE",
  "PATCH",
  "POST",
  "PUT"
]);

type UnknownRecord = Record<string, unknown>;

const MAX_SCHEMA_VALUE_COUNT = 100_000;
const MAX_SCHEMA_VALUE_CONTAINERS = 10_000;
const MAX_SCHEMA_VALUE_CHILDREN = 10_000;
const MAX_SCHEMA_VALUE_DEPTH = 64;
const MAX_SCHEMA_VALUE_STRING_LENGTH = 65_536;
const MAX_MANIFEST_SOURCE_LENGTH = 8 * 1024 * 1024;
const MAX_MANIFEST_VALUE_COUNT = 100_000;
const MAX_MANIFEST_CHILDREN = 10_000;
const MAX_MANIFEST_DEPTH = 64;
const MAX_MANIFEST_STRING_LENGTH = 65_536;
const MAX_MANIFEST_TOTAL_STRING_LENGTH = 8 * 1024 * 1024;

interface SchemaValueBudget {
  values: number;
  containers: number;
}

function fail(path: string, reason: string): never {
  throw new SchemaManifestValidationError(path, reason);
}

function valueDescription(value: unknown): string {
  if (value === null) return "null";
  try {
    if (Array.isArray(value)) return "an array";
  } catch {
    return "an unreadable value";
  }
  return typeof value === "string" ? JSON.stringify(value) : typeof value;
}

function assertRecord(
  value: unknown,
  path: string
): asserts value is UnknownRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(path, `must be an object; received ${valueDescription(value)}`);
  }
  let prototype: object | null;
  try {
    prototype = Object.getPrototypeOf(value);
  } catch {
    fail(path, "must be a readable plain JSON object");
  }
  if (prototype !== Object.prototype && prototype !== null) {
    fail(path, "must be a plain JSON object");
  }
}

function childPath(path: string, key: string): string {
  const displayKey = key.length > 128 ? `${key.slice(0, 125)}...` : key;
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(displayKey)
    ? `${path}.${displayKey}`
    : `${path}[${JSON.stringify(displayKey)}]`;
}

interface ManifestBoundsFrame {
  readonly value: unknown;
  readonly path: string;
  readonly depth: number;
  readonly parent?: unknown[] | UnknownRecord;
  readonly key?: string | number;
  readonly exit?: boolean;
}

interface ManifestBoundsBudget {
  values: number;
  stringLength: number;
}

function readDataDescriptor(
  value: object,
  key: string,
  path: string
): PropertyDescriptor {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, key);
  } catch {
    fail(path, "could not be inspected");
  }
  if (descriptor === undefined) {
    fail(path, "must be present as an own property");
  }
  if (!("value" in descriptor)) {
    fail(path, "must not use an accessor property");
  }
  return descriptor;
}

function assignSnapshotValue(
  frame: ManifestBoundsFrame,
  value: unknown
): void {
  if (frame.parent === undefined || frame.key === undefined) return;
  if (Array.isArray(frame.parent)) {
    frame.parent[frame.key as number] = value;
  } else {
    frame.parent[frame.key] = value;
  }
}

/** Build bounded, data-only JSON so semantic validation never rereads hostile input. */
function createManifestSnapshot(root: unknown): unknown {
  const pending: ManifestBoundsFrame[] = [
    { value: root, path: "$", depth: 0 }
  ];
  const active = new WeakSet<object>();
  const budget: ManifestBoundsBudget = { values: 0, stringLength: 0 };
  let snapshot: unknown;

  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current.exit) {
      active.delete(current.value as object);
      continue;
    }
    budget.values += 1;
    if (budget.values > MAX_MANIFEST_VALUE_COUNT) {
      fail(
        current.path,
        `must not contain more than ${MAX_MANIFEST_VALUE_COUNT} JSON values`
      );
    }
    if (current.depth > MAX_MANIFEST_DEPTH) {
      fail(
        current.path,
        `must not exceed a nesting depth of ${MAX_MANIFEST_DEPTH}`
      );
    }

    const item = current.value;
    if (typeof item === "string") {
      if (item.length > MAX_MANIFEST_STRING_LENGTH) {
        fail(
          current.path,
          `must not contain strings longer than ${MAX_MANIFEST_STRING_LENGTH} characters`
        );
      }
      budget.stringLength += item.length;
      if (budget.stringLength > MAX_MANIFEST_TOTAL_STRING_LENGTH) {
        fail(
          current.path,
          `must not contain more than ${MAX_MANIFEST_TOTAL_STRING_LENGTH} total string characters`
        );
      }
      assignSnapshotValue(current, item);
      if (current.parent === undefined) snapshot = item;
      continue;
    }
    if (item === null || typeof item === "boolean") {
      assignSnapshotValue(current, item);
      if (current.parent === undefined) snapshot = item;
      continue;
    }
    if (typeof item === "number") {
      if (!Number.isFinite(item)) {
        fail(current.path, "must not contain a non-finite number");
      }
      if (Number.isInteger(item) && !Number.isSafeInteger(item)) {
        fail(
          current.path,
          "must not contain an integer outside the JavaScript safe integer range"
        );
      }
      assignSnapshotValue(current, item);
      if (current.parent === undefined) snapshot = item;
      continue;
    }
    if (typeof item !== "object") {
      fail(current.path, "must contain only JSON-compatible values");
    }

    if (active.has(item)) {
      fail(current.path, "must not contain circular object references");
    }
    active.add(item);
    pending.push({ ...current, exit: true });

    let isArray: boolean;
    try {
      isArray = Array.isArray(item);
    } catch {
      fail(current.path, "could not be inspected as JSON");
    }
    if (isArray) {
      const lengthDescriptor = readDataDescriptor(
        item,
        "length",
        `${current.path}.length`
      );
      const length = lengthDescriptor.value;
      if (!Number.isSafeInteger(length) || (length as number) < 0) {
        fail(`${current.path}.length`, "must be a non-negative safe integer");
      }
      if ((length as number) > MAX_MANIFEST_CHILDREN) {
        fail(
          current.path,
          `must not contain arrays with more than ${MAX_MANIFEST_CHILDREN} entries`
        );
      }
      let ownKeys: PropertyKey[];
      try {
        ownKeys = Reflect.ownKeys(item);
      } catch {
        fail(current.path, "properties could not be enumerated");
      }
      if (ownKeys.some(key => typeof key === "symbol")) {
        fail(current.path, "must not contain symbol properties");
      }
      const expectedKeys = new Set([
        "length",
        ...Array.from({ length: length as number }, (_, index) => String(index))
      ]);
      for (const key of ownKeys as string[]) {
        if (!expectedKeys.has(key)) {
          fail(childPath(current.path, key), "is not a JSON array index");
        }
      }
      const output: unknown[] = new Array(length as number);
      assignSnapshotValue(current, output);
      if (current.parent === undefined) snapshot = output;
      for (let index = (length as number) - 1; index >= 0; index -= 1) {
        const itemPath = `${current.path}[${index}]`;
        const descriptor = readDataDescriptor(item, String(index), itemPath);
        if (descriptor.enumerable !== true) {
          fail(itemPath, "must be an enumerable JSON array item");
        }
        pending.push({
          value: descriptor.value,
          path: itemPath,
          depth: current.depth + 1,
          parent: output,
          key: index
        });
      }
      continue;
    }

    assertRecord(item, current.path);
    let ownKeys: PropertyKey[];
    try {
      ownKeys = Reflect.ownKeys(item);
    } catch {
      fail(current.path, "properties could not be enumerated");
    }
    if (ownKeys.some(key => typeof key === "symbol")) {
      fail(current.path, "must not contain symbol properties");
    }
    const keys = ownKeys as string[];
    if (keys.length > MAX_MANIFEST_CHILDREN) {
      fail(
        current.path,
        `must not contain objects with more than ${MAX_MANIFEST_CHILDREN} properties`
      );
    }
    const output: UnknownRecord = Object.create(null) as UnknownRecord;
    assignSnapshotValue(current, output);
    if (current.parent === undefined) snapshot = output;
    for (let index = keys.length - 1; index >= 0; index -= 1) {
      const key = keys[index];
      const itemPath = childPath(current.path, key);
      if (key.length > MAX_MANIFEST_STRING_LENGTH) {
        fail(
          itemPath,
          `must not contain keys longer than ${MAX_MANIFEST_STRING_LENGTH} characters`
        );
      }
      budget.stringLength += key.length;
      if (budget.stringLength > MAX_MANIFEST_TOTAL_STRING_LENGTH) {
        fail(
          itemPath,
          `must not contain more than ${MAX_MANIFEST_TOTAL_STRING_LENGTH} total string characters`
        );
      }
      const descriptor = readDataDescriptor(item, key, itemPath);
      if (descriptor.enumerable !== true) {
        fail(itemPath, "must be an enumerable JSON property");
      }
      pending.push({
        value: descriptor.value,
        path: itemPath,
        depth: current.depth + 1,
        parent: output,
        key
      });
    }
  }
  return snapshot;
}

function assertExactKeys(
  value: UnknownRecord,
  path: string,
  required: readonly string[],
  optional: readonly string[] = []
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      fail(childPath(path, key), "is not a supported field");
    }
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      fail(childPath(path, key), "is required");
    }
  }
}

function assertString(value: unknown, path: string): asserts value is string {
  if (typeof value !== "string") {
    fail(path, `must be a string; received ${valueDescription(value)}`);
  }
}

function containsControlCharacter(value: string): boolean {
  return [...value].some(character => {
    const codePoint = character.codePointAt(0)!;
    return codePoint < 32 || (codePoint >= 127 && codePoint <= 159);
  });
}

function assertMetadataName(value: unknown, path: string): asserts value is string {
  assertString(value, path);
  if (!value.trim() || value.length > 128) {
    fail(path, "must be non-empty and at most 128 characters");
  }
  if (containsControlCharacter(value)) {
    fail(path, "must not contain control characters");
  }
}

function assertContractName(value: unknown, path: string): asserts value is string {
  assertMetadataName(value, path);
}

function assertRoutePath(value: unknown, path: string): asserts value is string {
  assertString(value, path);
  if (!value.startsWith("/") || value.length > 2048) {
    fail(path, "must start with '/' and be at most 2048 characters");
  }
  if (containsControlCharacter(value)) {
    fail(path, "must not contain control characters");
  }
}

function assertJsonSchema(
  value: unknown,
  path: string,
  budget: SchemaValueBudget
): asserts value is JsonSchema {
  assertRecord(value, path);

  const pending: Array<{ path: string; value: unknown; depth: number }> = [
    { path, value, depth: 0 }
  ];
  const visited = new WeakSet<object>();
  while (pending.length > 0) {
    const current = pending.pop()!;
    const item = current.value;
    budget.values += 1;
    if (budget.values > MAX_SCHEMA_VALUE_COUNT) {
      fail(
        current.path,
        `schemas must not contain more than ${MAX_SCHEMA_VALUE_COUNT} JSON values`
      );
    }

    if (
      item === null ||
      typeof item === "string" ||
      typeof item === "boolean"
    ) {
      if (
        typeof item === "string" &&
        item.length > MAX_SCHEMA_VALUE_STRING_LENGTH
      ) {
        fail(
          current.path,
          `must not contain strings longer than ${MAX_SCHEMA_VALUE_STRING_LENGTH} characters`
        );
      }
      continue;
    }
    if (current.depth > MAX_SCHEMA_VALUE_DEPTH) {
      fail(
        current.path,
        `schema value nesting exceeds the maximum of ${MAX_SCHEMA_VALUE_DEPTH}`
      );
    }
    if (typeof item === "number") {
      if (!Number.isFinite(item)) {
        fail(current.path, "must not contain a non-finite number");
      }
      continue;
    }
    if (typeof item !== "object") {
      fail(
        current.path,
        `must contain only JSON values; received ${valueDescription(item)}`
      );
    }
    if (visited.has(item)) {
      fail(current.path, "must not contain circular or shared object references");
    }
    visited.add(item);
    budget.containers += 1;
    if (budget.containers > MAX_SCHEMA_VALUE_CONTAINERS) {
      fail(
        current.path,
        `schemas must not contain more than ${MAX_SCHEMA_VALUE_CONTAINERS} JSON containers`
      );
    }

    if (Array.isArray(item)) {
      if (item.length > MAX_SCHEMA_VALUE_CHILDREN) {
        fail(
          current.path,
          `must not contain arrays with more than ${MAX_SCHEMA_VALUE_CHILDREN} entries`
        );
      }
      for (let index = item.length - 1; index >= 0; index -= 1) {
        pending.push({
          path: `${current.path}[${index}]`,
          value: item[index],
          depth: current.depth + 1
        });
      }
      continue;
    }

    assertRecord(item, current.path);
    const keys = Object.keys(item);
    if (keys.length > MAX_SCHEMA_VALUE_CHILDREN) {
      fail(
        current.path,
        `must not contain objects with more than ${MAX_SCHEMA_VALUE_CHILDREN} properties`
      );
    }
    for (const key of keys) {
      if (key.length > MAX_SCHEMA_VALUE_STRING_LENGTH) {
        fail(
          childPath(current.path, key),
          `must not contain strings longer than ${MAX_SCHEMA_VALUE_STRING_LENGTH} characters`
        );
      }
      pending.push({
        path: childPath(current.path, key),
        value: item[key],
        depth: current.depth + 1
      });
    }
  }

  validateJsonSchemaKeywords(value, path);
}

const JSON_SCHEMA_TYPES = new Set([
  "array",
  "boolean",
  "integer",
  "null",
  "number",
  "object",
  "string"
]);

function queueSubschema(
  pending: Array<{ path: string; value: UnknownRecord }>,
  value: unknown,
  path: string
): void {
  if (typeof value === "boolean") return;
  assertRecord(value, path);
  pending.push({ path, value });
}

function queueSubschemaMap(
  pending: Array<{ path: string; value: UnknownRecord }>,
  value: unknown,
  path: string
): void {
  assertRecord(value, path);
  for (const key of Object.keys(value)) {
    queueSubschema(pending, value[key], childPath(path, key));
  }
}

function queueSubschemaArray(
  pending: Array<{ path: string; value: UnknownRecord }>,
  value: unknown,
  path: string,
  allowEmpty: boolean
): void {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    fail(
      path,
      allowEmpty
        ? "must be an array of schemas"
        : "must be a non-empty array of schemas"
    );
  }
  for (let index = 0; index < value.length; index += 1) {
    queueSubschema(pending, value[index], `${path}[${index}]`);
  }
}

function validateSchemaType(value: unknown, path: string): void {
  const types = Array.isArray(value) ? value : [value];
  if (types.length === 0) {
    fail(path, "must contain at least one JSON Schema type");
  }
  const seen = new Set<string>();
  for (let index = 0; index < types.length; index += 1) {
    const typePath = Array.isArray(value) ? `${path}[${index}]` : path;
    const type = types[index];
    if (typeof type !== "string" || !JSON_SCHEMA_TYPES.has(type)) {
      fail(typePath, "must be a valid JSON Schema type");
    }
    if (seen.has(type)) {
      fail(typePath, `duplicates the JSON Schema type ${JSON.stringify(type)}`);
    }
    seen.add(type);
  }
}

function validateStringArray(value: unknown, path: string): void {
  if (!Array.isArray(value)) {
    fail(path, "must be an array of strings");
  }
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    if (typeof item !== "string") {
      fail(`${path}[${index}]`, "must be a string");
    }
    if (seen.has(item)) {
      fail(`${path}[${index}]`, `duplicates ${JSON.stringify(item)}`);
    }
    seen.add(item);
  }
}

function validateJsonSchemaKeywords(value: UnknownRecord, path: string): void {
  const pending: Array<{ path: string; value: UnknownRecord }> = [{ path, value }];
  const visited = new WeakSet<object>();

  while (pending.length > 0) {
    const current = pending.pop()!;
    if (visited.has(current.value)) continue;
    visited.add(current.value);
    const schema = current.value;

    if (schema.$ref !== undefined && typeof schema.$ref !== "string") {
      fail(`${current.path}.$ref`, "must be a string");
    }
    if (schema.type !== undefined) {
      validateSchemaType(schema.type, `${current.path}.type`);
    }
    if (schema.required !== undefined) {
      validateStringArray(schema.required, `${current.path}.required`);
    }
    if (
      schema.enum !== undefined &&
      (!Array.isArray(schema.enum) || schema.enum.length === 0)
    ) {
      fail(`${current.path}.enum`, "must be a non-empty array");
    }

    if (schema.$defs !== undefined) {
      queueSubschemaMap(pending, schema.$defs, `${current.path}.$defs`);
    }
    if (schema.definitions !== undefined) {
      queueSubschemaMap(pending, schema.definitions, `${current.path}.definitions`);
    }
    if (schema.properties !== undefined) {
      queueSubschemaMap(pending, schema.properties, `${current.path}.properties`);
    }
    if (schema.patternProperties !== undefined) {
      queueSubschemaMap(
        pending,
        schema.patternProperties,
        `${current.path}.patternProperties`
      );
    }
    if (schema.dependentSchemas !== undefined) {
      queueSubschemaMap(
        pending,
        schema.dependentSchemas,
        `${current.path}.dependentSchemas`
      );
    }

    for (const keyword of [
      "additionalProperties",
      "contains",
      "contentSchema",
      "else",
      "if",
      "items",
      "not",
      "propertyNames",
      "then",
      "unevaluatedItems",
      "unevaluatedProperties"
    ]) {
      if (schema[keyword] !== undefined) {
        queueSubschema(
          pending,
          schema[keyword],
          childPath(current.path, keyword)
        );
      }
    }

    for (const keyword of ["allOf", "anyOf", "oneOf"] as const) {
      if (schema[keyword] !== undefined) {
        queueSubschemaArray(
          pending,
          schema[keyword],
          childPath(current.path, keyword),
          false
        );
      }
    }
    if (schema.prefixItems !== undefined) {
      queueSubschemaArray(
        pending,
        schema.prefixItems,
        `${current.path}.prefixItems`,
        true
      );
    }
  }
}

function assertResourceKey(value: string, path: string): void {
  if (!value.trim() || value.length > 128) {
    fail(path, "must be non-empty and at most 128 characters");
  }
  if (
    value.includes(",") ||
    containsControlCharacter(value)
  ) {
    fail(path, "must not contain commas or control characters");
  }
}

function validateParameter(
  value: unknown,
  path: string,
  budget: SchemaValueBudget
): asserts value is FluxFastRouteParameterSchema {
  assertRecord(value, path);
  assertExactKeys(value, path, ["name", "location", "required", "schema"]);
  assertMetadataName(value.name, `${path}.name`);
  if (value.location !== "path" && value.location !== "query") {
    fail(`${path}.location`, 'must be either "path" or "query"');
  }
  if (typeof value.required !== "boolean") {
    fail(`${path}.required`, "must be a boolean");
  }
  if (value.location === "path" && !value.required) {
    fail(`${path}.required`, "must be true for path parameters");
  }
  assertJsonSchema(value.schema, `${path}.schema`, budget);
}

function validateParameters(
  value: unknown,
  path: string,
  budget: SchemaValueBudget
): FluxFastRouteParameterSchema[] {
  if (!Array.isArray(value)) {
    fail(path, `must be an array; received ${valueDescription(value)}`);
  }
  const identities = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const parameterPath = `${path}[${index}]`;
    const parameter = value[index];
    validateParameter(parameter, parameterPath, budget);
    const identity = `${parameter.location}\u0000${parameter.name}`;
    if (identities.has(identity)) {
      fail(
        parameterPath,
        `duplicates the ${parameter.location} parameter ${JSON.stringify(parameter.name)}`
      );
    }
    identities.add(identity);
  }
  return value;
}

function validateResources(
  value: unknown,
  path: string,
  budget: SchemaValueBudget
): asserts value is Record<string, FluxFastResourceSchemaEntry> {
  assertRecord(value, path);
  for (const key of Object.keys(value)) {
    const resourcePath = childPath(path, key);
    assertResourceKey(key, resourcePath);
    const entry = value[key];
    assertRecord(entry, resourcePath);
    assertExactKeys(entry, resourcePath, ["schema"]);
    assertJsonSchema(entry.schema, `${resourcePath}.schema`, budget);
  }
}

function validateTypes(
  value: unknown,
  path: string,
  budget: SchemaValueBudget
): asserts value is Record<string, FluxFastTypeSchemaEntry> {
  assertRecord(value, path);
  for (const key of Object.keys(value)) {
    const typePath = childPath(path, key);
    assertContractName(key, typePath);
    const entry = value[key];
    assertRecord(entry, typePath);
    assertExactKeys(entry, typePath, ["mode", "schema"]);
    if (entry.mode !== "serialization" && entry.mode !== "validation") {
      fail(
        `${typePath}.mode`,
        'must be either "serialization" or "validation"'
      );
    }
    assertJsonSchema(entry.schema, `${typePath}.schema`, budget);
  }
}

function validatePages(
  value: unknown,
  path: string,
  budget: SchemaValueBudget
): asserts value is FluxFastPageRouteSchema[] {
  if (!Array.isArray(value)) {
    fail(path, `must be an array; received ${valueDescription(value)}`);
  }
  for (let index = 0; index < value.length; index += 1) {
    const pagePath = `${path}[${index}]`;
    const page = value[index];
    assertRecord(page, pagePath);
    assertExactKeys(page, pagePath, ["name", "path", "parameters"]);
    assertMetadataName(page.name, `${pagePath}.name`);
    assertRoutePath(page.path, `${pagePath}.path`);
    validateParameters(page.parameters, `${pagePath}.parameters`, budget);
  }
}

function validateMutations(
  value: unknown,
  path: string,
  budget: SchemaValueBudget
): asserts value is FluxFastMutationRouteSchema[] {
  if (!Array.isArray(value)) {
    fail(path, `must be an array; received ${valueDescription(value)}`);
  }
  for (let index = 0; index < value.length; index += 1) {
    const mutationPath = `${path}[${index}]`;
    const mutation = value[index];
    assertRecord(mutation, mutationPath);
    assertExactKeys(
      mutation,
      mutationPath,
      ["name", "path", "method", "parameters"],
      ["body"]
    );
    assertMetadataName(mutation.name, `${mutationPath}.name`);
    assertRoutePath(mutation.path, `${mutationPath}.path`);
    if (
      typeof mutation.method !== "string" ||
      !MUTATION_METHODS.has(mutation.method as FluxFastMutationMethod)
    ) {
      fail(
        `${mutationPath}.method`,
        'must be one of "DELETE", "PATCH", "POST", or "PUT"'
      );
    }
    validateParameters(mutation.parameters, `${mutationPath}.parameters`, budget);
    if (mutation.body !== undefined && mutation.body !== null) {
      assertJsonSchema(mutation.body, `${mutationPath}.body`, budget);
    }
  }
}

/**
 * Validate an already parsed manifest and return a bounded data-only snapshot.
 * The snapshot intentionally does not preserve input object identity or prototypes.
 */
export function validateFluxFastSchemaManifest(
  value: unknown
): FluxFastSchemaManifest {
  const snapshot = createManifestSnapshot(value);
  assertRecord(snapshot, "$");
  assertExactKeys(snapshot, "$", [
    "schema",
    "producer",
    "fingerprint",
    "resources",
    "pages",
    "mutations"
  ], ["types"]);

  if (
    snapshot.schema !== FLUXFAST_SCHEMA_MANIFEST_V1 &&
    snapshot.schema !== FLUXFAST_SCHEMA_MANIFEST_V2
  ) {
    fail(
      "$.schema",
      `unsupported version ${JSON.stringify(snapshot.schema)}; expected ${JSON.stringify(
        FLUXFAST_SCHEMA_MANIFEST_V1
      )} or ${JSON.stringify(FLUXFAST_SCHEMA_MANIFEST_V2)}`
    );
  }

  if (snapshot.schema === FLUXFAST_SCHEMA_MANIFEST_V1) {
    if (snapshot.types !== undefined) {
      fail("$.types", "fluxfast-schema/1 cannot contain explicit type contracts");
    }
  } else {
    if (snapshot.types === undefined) {
      fail("$.types", "is required for fluxfast-schema/2");
    }
  }

  assertString(snapshot.producer, "$.producer");
  if (!SEMVER_PATTERN.test(snapshot.producer)) {
    fail("$.producer", "must use semantic version format");
  }

  assertString(snapshot.fingerprint, "$.fingerprint");
  if (!FINGERPRINT_PATTERN.test(snapshot.fingerprint)) {
    fail("$.fingerprint", "must be a lowercase SHA-256 digest");
  }

  const schemaBudget: SchemaValueBudget = { values: 0, containers: 0 };
  if (snapshot.schema === FLUXFAST_SCHEMA_MANIFEST_V2) {
    validateTypes(snapshot.types, "$.types", schemaBudget);
  }
  validateResources(snapshot.resources, "$.resources", schemaBudget);
  validatePages(snapshot.pages, "$.pages", schemaBudget);
  validateMutations(snapshot.mutations, "$.mutations", schemaBudget);

  return snapshot as unknown as FluxFastSchemaManifest;
}

/** Parse JSON and validate it as a supported FluxFast schema manifest. */
export function parseFluxFastSchemaManifest(
  source: string
): FluxFastSchemaManifest {
  if (source.length > MAX_MANIFEST_SOURCE_LENGTH) {
    fail(
      "$",
      `source must not exceed ${MAX_MANIFEST_SOURCE_LENGTH} characters`
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    const reason =
      error instanceof Error ? error.message : "unknown JSON parse error";
    fail("$", `must be valid JSON (${reason})`);
  }
  return validateFluxFastSchemaManifest(value);
}
