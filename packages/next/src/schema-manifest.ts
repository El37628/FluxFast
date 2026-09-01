/** Runtime validation for the offline FluxFast developer schema manifest. */

export const FLUXFAST_SCHEMA_MANIFEST_VERSION = "fluxfast-schema/1" as const;

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
  schema: typeof FLUXFAST_SCHEMA_MANIFEST_VERSION;
  producer: string;
  fingerprint: string;
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

function fail(path: string, reason: string): never {
  throw new SchemaManifestValidationError(path, reason);
}

function valueDescription(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return typeof value === "string" ? JSON.stringify(value) : typeof value;
}

function assertRecord(
  value: unknown,
  path: string
): asserts value is UnknownRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(path, `must be an object; received ${valueDescription(value)}`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail(path, "must be a plain JSON object");
  }
}

function childPath(path: string, key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)
    ? `${path}.${key}`
    : `${path}[${JSON.stringify(key)}]`;
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

function assertMetadataName(value: unknown, path: string): asserts value is string {
  assertString(value, path);
  if (!value.trim() || value.length > 128) {
    fail(path, "must be non-empty and at most 128 characters");
  }
  if ([...value].some(character => character.codePointAt(0)! < 32)) {
    fail(path, "must not contain control characters");
  }
}

function assertRoutePath(value: unknown, path: string): asserts value is string {
  assertString(value, path);
  if (!value.startsWith("/") || value.length > 2048) {
    fail(path, "must start with '/' and be at most 2048 characters");
  }
  if ([...value].some(character => character.codePointAt(0)! < 32)) {
    fail(path, "must not contain control characters");
  }
}

function assertJsonSchema(value: unknown, path: string): asserts value is JsonSchema {
  assertRecord(value, path);

  const pending: Array<{ path: string; value: unknown }> = [{ path, value }];
  const visited = new WeakSet<object>();

  while (pending.length > 0) {
    const current = pending.pop()!;
    const item = current.value;

    if (
      item === null ||
      typeof item === "string" ||
      typeof item === "boolean"
    ) {
      continue;
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

    if (Array.isArray(item)) {
      for (let index = item.length - 1; index >= 0; index -= 1) {
        pending.push({ path: `${current.path}[${index}]`, value: item[index] });
      }
      continue;
    }

    assertRecord(item, current.path);
    for (const key of Object.keys(item)) {
      pending.push({
        path: childPath(current.path, key),
        value: item[key]
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
    [...value].some(character => character.codePointAt(0)! < 32)
  ) {
    fail(path, "must not contain commas or control characters");
  }
}

function validateParameter(
  value: unknown,
  path: string
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
  assertJsonSchema(value.schema, `${path}.schema`);
}

function validateParameters(
  value: unknown,
  path: string
): FluxFastRouteParameterSchema[] {
  if (!Array.isArray(value)) {
    fail(path, `must be an array; received ${valueDescription(value)}`);
  }
  const identities = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const parameterPath = `${path}[${index}]`;
    const parameter = value[index];
    validateParameter(parameter, parameterPath);
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
  path: string
): asserts value is Record<string, FluxFastResourceSchemaEntry> {
  assertRecord(value, path);
  for (const key of Object.keys(value)) {
    const resourcePath = childPath(path, key);
    assertResourceKey(key, resourcePath);
    const entry = value[key];
    assertRecord(entry, resourcePath);
    assertExactKeys(entry, resourcePath, ["schema"]);
    assertJsonSchema(entry.schema, `${resourcePath}.schema`);
  }
}

function validatePages(
  value: unknown,
  path: string
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
    validateParameters(page.parameters, `${pagePath}.parameters`);
  }
}

function validateMutations(
  value: unknown,
  path: string
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
    validateParameters(mutation.parameters, `${mutationPath}.parameters`);
    if (mutation.body !== undefined && mutation.body !== null) {
      assertJsonSchema(mutation.body, `${mutationPath}.body`);
    }
  }
}

/** Validate an already parsed manifest and return it with a precise type. */
export function validateFluxFastSchemaManifest(
  value: unknown
): FluxFastSchemaManifest {
  assertRecord(value, "$");
  assertExactKeys(value, "$", [
    "schema",
    "producer",
    "fingerprint",
    "resources",
    "pages",
    "mutations"
  ]);

  if (value.schema !== FLUXFAST_SCHEMA_MANIFEST_VERSION) {
    fail(
      "$.schema",
      `unsupported version ${JSON.stringify(value.schema)}; expected ${JSON.stringify(
        FLUXFAST_SCHEMA_MANIFEST_VERSION
      )}`
    );
  }

  assertString(value.producer, "$.producer");
  if (!SEMVER_PATTERN.test(value.producer)) {
    fail("$.producer", "must use semantic version format");
  }

  assertString(value.fingerprint, "$.fingerprint");
  if (!FINGERPRINT_PATTERN.test(value.fingerprint)) {
    fail("$.fingerprint", "must be a lowercase SHA-256 digest");
  }

  validateResources(value.resources, "$.resources");
  validatePages(value.pages, "$.pages");
  validateMutations(value.mutations, "$.mutations");

  return value as unknown as FluxFastSchemaManifest;
}

/** Parse JSON and validate it as a supported FluxFast schema manifest. */
export function parseFluxFastSchemaManifest(
  source: string
): FluxFastSchemaManifest {
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
