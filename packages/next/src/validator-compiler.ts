import type {
  ValidationPlan,
  ValidationPlanDocument
} from "@fluxfast/core";
import {
  validationPatternError
} from "@fluxfast/core";
import {
  mutationBodyTypeName,
  pascalIdentifier,
  SchemaCompilationError
} from "./schema-compiler";
import {
  type FluxFastMutationRouteSchema,
  type FluxFastSchemaManifest,
  type JsonSchema,
  validateFluxFastSchemaManifest
} from "./schema-manifest";

type SchemaNode = JsonSchema | boolean;
type PlanDocument = ValidationPlanDocument;

/** A deterministic code-generation error tied to one manifest location. */
export class ValidatorCompilationError extends SchemaCompilationError {
  readonly keyword?: string;
  readonly unsupported: boolean;

  constructor(
    path: string,
    reason: string,
    keyword?: string,
    unsupported = false
  ) {
    super(path, reason);
    this.name = "ValidatorCompilationError";
    this.keyword = keyword;
    this.unsupported = unsupported;
  }
}

function fail(
  path: string,
  reason: string,
  keyword?: string,
  unsupported = false
): never {
  throw new ValidatorCompilationError(path, reason, keyword, unsupported);
}

function unsupported(
  path: string,
  reason: string,
  keyword?: string
): never {
  return fail(path, reason, keyword, true);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function childPath(path: string, key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)
    ? path + "." + key
    : path + "[" + JSON.stringify(key) + "]";
}

function indexPath(path: string, index: number): string {
  return path + "[" + index + "]";
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return "[" + value.map(item => canonicalJson(item)).join(",") + "]";
  }
  if (isRecord(value)) {
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map(key => JSON.stringify(key) + ":" + canonicalJson(value[key]))
        .join(",") +
      "}"
    );
  }
  return JSON.stringify(value);
}

function schemaRecord(value: unknown, path: string): JsonSchema {
  if (!isRecord(value)) {
    fail(path, "expected a JSON Schema object");
  }
  return value as JsonSchema;
}

function schemaMap(value: unknown, path: string): Record<string, SchemaNode> {
  const record = schemaRecord(value, path);
  const result: Record<string, SchemaNode> = Object.create(null) as Record<
    string,
    SchemaNode
  >;
  for (const key of Object.keys(record)) {
    const item = record[key];
    result[key] = typeof item === "boolean"
      ? item
      : schemaRecord(item, childPath(path, key));
  }
  return result;
}

function schemaArray(value: unknown, path: string): SchemaNode[] {
  if (!Array.isArray(value)) {
    fail(path, "expected an array of JSON Schemas");
  }
  return value.map((item, index) =>
    typeof item === "boolean"
      ? item
      : schemaRecord(item, indexPath(path, index))
  );
}

/*
 * These are the only JSON Schema keywords for which the generated runtime has
 * faithful semantics. Metadata is accepted and discarded; every other
 * keyword is rejected instead of being silently dropped.
 */
const SUPPORTED_KEYWORDS = new Set([
  "$defs",
  "$ref",
  "$schema",
  "$id",
  "$anchor",
  "$comment",
  "additionalProperties",
  "allOf",
  "anyOf",
  "const",
  "default",
  "definitions",
  "deprecated",
  "description",
  "discriminator",
  "enum",
  "examples",
  "exclusiveMaximum",
  "exclusiveMinimum",
  "format",
  "items",
  "maxItems",
  "maxLength",
  "maximum",
  "minItems",
  "minLength",
  "minimum",
  "multipleOf",
  "oneOf",
  "pattern",
  "prefixItems",
  "properties",
  "readOnly",
  "required",
  "title",
  "type",
  "writeOnly",
  // OpenAPI's nullable flag is emitted by some adapters.
  "nullable"
]);

const SUBSCHEMA_KEYS = new Set([
  "$defs",
  "definitions",
  "properties",
  "additionalProperties",
  "allOf",
  "anyOf",
  "oneOf",
  "items",
  "prefixItems"
]);

const SUPPORTED_FORMATS = new Set([
  "date",
  "date-time",
  "email",
  "ipv4",
  "ipv6",
  "time",
  "uri",
  "uuid"
]);

function assertSupportedKeywords(
  schema: SchemaNode,
  path: string,
  visited = new WeakSet<object>()
): void {
  if (typeof schema === "boolean") return;
  if (!isRecord(schema)) fail(path, "expected a JSON Schema object");
  if (visited.has(schema)) return;
  visited.add(schema);

  for (const key of Object.keys(schema).sort()) {
    if (!SUPPORTED_KEYWORDS.has(key)) {
      unsupported(
        childPath(path, key),
        "unsupported validation keyword " + JSON.stringify(key),
        key
      );
    }
    if (key === "format" && typeof schema[key] === "string" &&
        !SUPPORTED_FORMATS.has(schema[key] as string)) {
      unsupported(
        childPath(path, key),
        "unsupported validation format " + JSON.stringify(schema[key]),
        key
      );
    }

    if (!SUBSCHEMA_KEYS.has(key)) continue;
    const value = schema[key];
    if (key === "$defs" || key === "definitions" || key === "properties") {
      const entries = schemaMap(value, childPath(path, key));
      for (const entry of Object.keys(entries).sort()) {
        assertSupportedKeywords(
          entries[entry],
          childPath(childPath(path, key), entry),
          visited
        );
      }
      continue;
    }
    if (
      key === "allOf" ||
      key === "anyOf" ||
      key === "oneOf" ||
      key === "prefixItems"
    ) {
      const entries = schemaArray(value, childPath(path, key));
      entries.forEach((entry, index) =>
        assertSupportedKeywords(
          entry,
          indexPath(childPath(path, key), index),
          visited
        )
      );
      continue;
    }
    if (typeof value !== "boolean") {
      assertSupportedKeywords(value as SchemaNode, childPath(path, key), visited);
    }
  }
}

function decodeReference(reference: string, path: string): string {
  if (reference === "#") return reference;
  const prefix = ["#/$defs/", "#/definitions/"].find(item =>
    reference.startsWith(item)
  );
  if (!prefix) {
    fail(
      path,
      "only local $defs references are supported; received " +
        JSON.stringify(reference),
      "$ref"
    );
  }
  const encoded = reference.slice(prefix.length);
  if (!encoded || encoded.includes("/")) {
    fail(
      path,
      "must point directly to a local definition; received " +
        JSON.stringify(reference),
      "$ref"
    );
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(encoded);
  } catch {
    fail(
      path,
      "contains invalid URI escaping: " + JSON.stringify(reference),
      "$ref"
    );
  }
  return decoded.replace(/~1/g, "/").replace(/~0/g, "~");
}

interface DefinitionEntry {
  readonly schema: SchemaNode;
  readonly path: string;
}

interface RootContract {
  readonly name: string;
  readonly schema: JsonSchema;
  readonly path: string;
}

interface CompiledContract {
  readonly name: string;
  readonly document: PlanDocument;
}

export interface ValidatorCompilationDiagnostic {
  readonly contract: string;
  readonly path: string;
  readonly keyword?: string;
  readonly message: string;
}

export interface ValidatorCompilationResult {
  readonly content: string;
  readonly diagnostics: readonly ValidatorCompilationDiagnostic[];
}

export interface ValidatorCompilationOptions {
  /** Report unsupported contracts while keeping TypeScript generation usable. */
  readonly unsupported?: "error" | "report";
}

function collectDefinitions(
  schema: SchemaNode,
  path: string,
  definitions: Map<string, DefinitionEntry>,
  visited = new WeakSet<object>()
): void {
  if (typeof schema === "boolean" || !isRecord(schema)) return;
  if (visited.has(schema)) return;
  visited.add(schema);

  for (const keyword of ["$defs", "definitions"] as const) {
    if (schema[keyword] === undefined) continue;
    const entries = schemaMap(schema[keyword], path + "." + keyword);
    for (const key of Object.keys(entries).sort()) {
      const entryPath = childPath(path + "." + keyword, key);
      const existing = definitions.get(key);
      if (existing && canonicalJson(existing.schema) !== canonicalJson(entries[key])) {
        fail(
          entryPath,
          "definition " + JSON.stringify(key) +
            " collides with an incompatible definition at " + existing.path
        );
      }
      if (!existing) definitions.set(key, { schema: entries[key], path: entryPath });
      collectDefinitions(entries[key], entryPath, definitions, visited);
    }
  }

  if (schema.properties !== undefined) {
    const entries = schemaMap(schema.properties, path + ".properties");
    for (const key of Object.keys(entries).sort()) {
      collectDefinitions(
        entries[key],
        childPath(path + ".properties", key),
        definitions,
        visited
      );
    }
  }
  for (const keyword of ["additionalProperties", "items"] as const) {
    const value = schema[keyword];
    if (value !== undefined && typeof value !== "boolean") {
      collectDefinitions(value as JsonSchema, path + "." + keyword, definitions, visited);
    }
  }
  for (const keyword of ["allOf", "anyOf", "oneOf", "prefixItems"] as const) {
    const value = schema[keyword];
    if (value === undefined) continue;
    const entries = schemaArray(value, path + "." + keyword);
    entries.forEach((entry, index) =>
      collectDefinitions(entry, indexPath(path + "." + keyword, index), definitions, visited)
    );
  }
}

function numberValue(value: unknown, path: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(path, "must be a finite number");
  }
  return value;
}

function integerValue(value: unknown, path: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    fail(path, "must be a non-negative integer");
  }
  return value;
}

function stringValue(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") fail(path, "must be a string");
  return value;
}

function commonFields(schema: JsonSchema): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  if (schema.nullable === true) fields.nullable = true;
  return fields;
}

function combinePlans(plans: ValidationPlan[]): ValidationPlan {
  if (plans.length === 0) return { kind: "any" };
  if (plans.length === 1) return plans[0];
  return { kind: "intersection", allOf: plans };
}

class JsonSchemaPlanCompiler {
  private readonly definitions = new Map<string, DefinitionEntry>();
  private readonly compiledDefinitions = new Map<string, ValidationPlan>();

  constructor(
    private readonly root: JsonSchema,
    private readonly rootPath: string
  ) {
    assertSupportedKeywords(root, rootPath);
    collectDefinitions(root, rootPath, this.definitions);
  }

  compile(): PlanDocument {
    const root = this.compileNode(this.root, this.rootPath);
    const definitions: Record<string, ValidationPlan> = Object.create(null) as Record<
      string,
      ValidationPlan
    >;
    for (const name of [...this.definitions.keys()].sort()) {
      definitions[name] = this.compileDefinition(name);
    }
    return Object.keys(definitions).length === 0
      ? { root }
      : { root, definitions };
  }

  private compileDefinition(name: string): ValidationPlan {
    const cached = this.compiledDefinitions.get(name);
    if (cached !== undefined) return cached;
    const definition = this.definitions.get(name);
    if (!definition) {
      fail(
        this.rootPath,
        "references unknown definition " + JSON.stringify(name),
        "$ref"
      );
    }
    const plan = this.compileNode(definition.schema, definition.path);
    this.compiledDefinitions.set(name, plan);
    return plan;
  }

  private compileNode(schema: SchemaNode, path: string): ValidationPlan {
    if (typeof schema === "boolean") return schema;
    if (!isRecord(schema)) fail(path, "expected a JSON Schema object");

    const parts: ValidationPlan[] = [];
    if (schema.$ref !== undefined) {
      if (typeof schema.$ref !== "string") {
        fail(path + ".$ref", "must be a string", "$ref");
      }
      const reference = decodeReference(schema.$ref, path + ".$ref");
      if (reference !== "#" && !this.definitions.has(reference)) {
        fail(
          path + ".$ref",
          "references unknown definition " + JSON.stringify(reference),
          "$ref"
        );
      }
      parts.push({ kind: "ref", ref: schema.$ref });
    }

    if (schema.const !== undefined) {
      parts.push({ kind: "literal", value: schema.const });
    }
    if (schema.enum !== undefined) {
      if (!Array.isArray(schema.enum) || schema.enum.length === 0) {
        fail(path + ".enum", "must be a non-empty array", "enum");
      }
      parts.push({ kind: "enum", values: schema.enum });
    }

    if (schema.anyOf !== undefined) {
      const alternatives = schemaArray(schema.anyOf, path + ".anyOf");
      if (alternatives.length === 0) fail(path + ".anyOf", "must not be empty", "anyOf");
      parts.push({
        kind: "union",
        anyOf: alternatives.map((item, index) =>
          this.compileNode(item, indexPath(path + ".anyOf", index))
        )
      });
    }
    if (schema.oneOf !== undefined) {
      const alternatives = schemaArray(schema.oneOf, path + ".oneOf");
      if (alternatives.length === 0) fail(path + ".oneOf", "must not be empty", "oneOf");
      parts.push({
        kind: "oneOf",
        anyOf: alternatives.map((item, index) =>
          this.compileNode(item, indexPath(path + ".oneOf", index))
        )
      });
    }
    if (schema.allOf !== undefined) {
      const members = schemaArray(schema.allOf, path + ".allOf");
      if (members.length === 0) fail(path + ".allOf", "must not be empty", "allOf");
      parts.push({
        kind: "intersection",
        allOf: members.map((item, index) =>
          this.compileNode(item, indexPath(path + ".allOf", index))
        )
      });
    }

    const types = schema.type === undefined
      ? []
      : Array.isArray(schema.type)
        ? schema.type
        : [schema.type];
    if (types.length === 0) {
      /*
       * JSON Schema permits type-specific keywords without a `type`, but the
       * compact FluxFast plan has no conditional keyword node. Treating one
       * of these schemas as `any` or as an unconditional object/array would
       * silently change the server contract. Surface it instead of emitting
       * a validator with weaker semantics. This also covers `$ref` siblings.
       */
      const typedKeyword = [
        "additionalProperties",
        "exclusiveMaximum",
        "exclusiveMinimum",
        "format",
        "items",
        "maxItems",
        "maxLength",
        "maximum",
        "minItems",
        "minLength",
        "minimum",
        "multipleOf",
        "pattern",
        "prefixItems",
        "properties",
        "required"
      ].find(keyword => schema[keyword] !== undefined);
      if (typedKeyword !== undefined) {
        unsupported(
          path + "." + typedKeyword,
          "validation keyword " + JSON.stringify(typedKeyword) +
            " requires an explicit JSON Schema type; refusing to drop its semantics",
          typedKeyword
        );
      }
    }
    if (types.length > 0) {
      const typePlans = types.map((type, index) => {
        if (typeof type !== "string") {
          fail(
            Array.isArray(schema.type)
              ? indexPath(path + ".type", index)
              : path + ".type",
            "must be a valid JSON Schema type",
            "type"
          );
        }
        return this.compileExplicitType(
          type,
          schema,
          Array.isArray(schema.type)
            ? indexPath(path + ".type", index)
            : path
        );
      });
      parts.push(
        typePlans.length === 1
          ? typePlans[0]
          : { kind: "union", anyOf: typePlans }
      );
    } else if (
      schema.properties !== undefined ||
      schema.additionalProperties !== undefined ||
      schema.required !== undefined
    ) {
      parts.push(this.compileObject(schema, path));
    } else if (schema.items !== undefined || schema.prefixItems !== undefined) {
      parts.push(this.compileArray(schema, path));
    }

    const result = combinePlans(parts);
    if (
      schema.nullable === true &&
      typeof result === "object" &&
      result !== null &&
      !Array.isArray(result)
    ) {
      (result as unknown as Record<string, unknown>).nullable = true;
    }
    return result;
  }

  private compileExplicitType(
    type: string,
    schema: JsonSchema,
    path: string
  ): ValidationPlan {
    const common = commonFields(schema);
    switch (type) {
      case "null":
        return { kind: "null", ...common } as ValidationPlan;
      case "boolean":
        return { kind: "boolean", ...common } as ValidationPlan;
      case "string": {
        const plan: Record<string, unknown> = { kind: "string", ...common };
        const minLength = integerValue(schema.minLength, path + ".minLength");
        const maxLength = integerValue(schema.maxLength, path + ".maxLength");
        if (minLength !== undefined) plan.minLength = minLength;
        if (maxLength !== undefined) plan.maxLength = maxLength;
        if (minLength !== undefined && maxLength !== undefined && minLength > maxLength) {
          fail(path, "minLength cannot exceed maxLength", "minLength");
        }
        const pattern = stringValue(schema.pattern, path + ".pattern");
        if (pattern !== undefined) {
          const patternError = validationPatternError(pattern);
          if (patternError !== undefined) {
            unsupported(path + ".pattern", patternError, "pattern");
          }
          try {
            new RegExp(pattern, "u");
          } catch (error) {
            fail(
              path + ".pattern",
              "is not a valid JavaScript regular expression (" +
                (error instanceof Error ? error.message : String(error)) +
                ")",
              "pattern"
            );
          }
          plan.pattern = pattern;
        }
        const format = stringValue(schema.format, path + ".format");
        if (format !== undefined) {
          if (!SUPPORTED_FORMATS.has(format)) {
            unsupported(
              path + ".format",
              "unsupported validation format " + JSON.stringify(format),
              "format"
            );
          }
          plan.format = format;
        }
        return plan as unknown as ValidationPlan;
      }
      case "number":
      case "integer": {
        const plan: Record<string, unknown> = { kind: type, ...common };
        for (const keyword of [
          "minimum",
          "maximum",
          "exclusiveMinimum",
          "exclusiveMaximum",
          "multipleOf"
        ] as const) {
          const number = numberValue(schema[keyword], path + "." + keyword);
          if (number !== undefined) plan[keyword] = number;
        }
        if (
          plan.multipleOf !== undefined &&
          (plan.multipleOf as number) <= 0
        ) {
          fail(path + ".multipleOf", "must be greater than zero", "multipleOf");
        }
        return plan as unknown as ValidationPlan;
      }
      case "array":
        return this.compileArray(schema, path);
      case "object":
        return this.compileObject(schema, path);
      default:
        fail(path + ".type", "unsupported JSON Schema type " + JSON.stringify(type), "type");
    }
  }

  private compileArray(schema: JsonSchema, path: string): ValidationPlan {
    const plan: Record<string, unknown> = {
      kind: "array",
      ...commonFields(schema)
    };
    if (schema.items !== undefined) {
      plan.items = typeof schema.items === "boolean"
        ? schema.items
        : this.compileNode(schema.items as JsonSchema, path + ".items");
    }
    if (schema.prefixItems !== undefined) {
      const entries = schemaArray(schema.prefixItems, path + ".prefixItems");
      plan.prefixItems = entries.map((entry, index) =>
        this.compileNode(entry, indexPath(path + ".prefixItems", index))
      );
    }
    const minItems = integerValue(schema.minItems, path + ".minItems");
    const maxItems = integerValue(schema.maxItems, path + ".maxItems");
    if (minItems !== undefined) plan.minItems = minItems;
    if (maxItems !== undefined) plan.maxItems = maxItems;
    if (minItems !== undefined && maxItems !== undefined && minItems > maxItems) {
      fail(path, "minItems cannot exceed maxItems", "minItems");
    }
    return plan as unknown as ValidationPlan;
  }

  private compileObject(schema: JsonSchema, path: string): ValidationPlan {
    const plan: Record<string, unknown> = {
      kind: "object",
      ...commonFields(schema)
    };
    if (schema.properties !== undefined) {
      const entries = schemaMap(schema.properties, path + ".properties");
      const properties: Record<string, ValidationPlan> = Object.create(null) as Record<
        string,
        ValidationPlan
      >;
      for (const key of Object.keys(entries).sort()) {
        properties[key] = this.compileNode(
          entries[key],
          childPath(path + ".properties", key)
        );
      }
      plan.properties = properties;
    }
    if (schema.required !== undefined) {
      if (!Array.isArray(schema.required)) {
        fail(path + ".required", "must be an array", "required");
      }
      const required: string[] = [];
      const seen = new Set<string>();
      schema.required.forEach((item, index) => {
        if (typeof item !== "string") {
          fail(indexPath(path + ".required", index), "must be a string", "required");
        }
        if (seen.has(item)) {
          fail(
            indexPath(path + ".required", index),
            "duplicates " + JSON.stringify(item),
            "required"
          );
        }
        seen.add(item);
        required.push(item);
      });
      plan.required = required.sort();
    }
    if (schema.additionalProperties !== undefined) {
      plan.additionalProperties = typeof schema.additionalProperties === "boolean"
        ? schema.additionalProperties
        : this.compileNode(
            schema.additionalProperties as JsonSchema,
            path + ".additionalProperties"
          );
    }
    return plan as unknown as ValidationPlan;
  }
}

/** Compile one manifest JSON Schema into the framework-neutral plan format. */
export function compileJsonSchemaToValidationPlan(
  schema: JsonSchema,
  path = "$"
): ValidationPlanDocument {
  return new JsonSchemaPlanCompiler(schema, path).compile();
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function resourceTypeName(resourceKey: string): string {
  return pascalIdentifier(resourceKey, "Resource") + "Resource";
}

function collectRootContracts(manifest: FluxFastSchemaManifest): RootContract[] {
  const result: RootContract[] = [];

  for (const name of Object.keys(manifest.types ?? {}).sort(compareText)) {
    result.push({
      name: pascalIdentifier(name, "Type"),
      schema: manifest.types![name].schema,
      path: childPath("$.types", name) + ".schema"
    });
  }

  /*
   * Resource aliases are generated contracts too. They are never validated
   * automatically by the runtime; exporting an opt-in validator keeps custom
   * fetch/persistence boundaries typed without adding a navigation hot-path
   * check.
   */
  for (const resourceKey of Object.keys(manifest.resources).sort(compareText)) {
    result.push({
      name: resourceTypeName(resourceKey),
      schema: manifest.resources[resourceKey].schema,
      path: childPath("$.resources", resourceKey) + ".schema"
    });
  }

  const mutations = manifest.mutations
    .map((mutation, sourceIndex) => ({ mutation, sourceIndex }))
    .filter(
      (entry): entry is {
        mutation: FluxFastMutationRouteSchema & { body: JsonSchema };
        sourceIndex: number;
      } => entry.mutation.body !== undefined && entry.mutation.body !== null
    )
    .sort(
      (left, right) =>
        compareText(left.mutation.name, right.mutation.name) ||
        compareText(left.mutation.path, right.mutation.path) ||
        compareText(left.mutation.method, right.mutation.method)
    );
  const groupSizes = new Map<string, number>();
  for (const entry of mutations) {
    const key = entry.mutation.name + "\u0000" + entry.mutation.path;
    groupSizes.set(key, (groupSizes.get(key) ?? 0) + 1);
  }
  for (const entry of mutations) {
    const mutation = entry.mutation;
    const groupSize = groupSizes.get(
      mutation.name + "\u0000" + mutation.path
    )!;
    result.push({
      name: mutationBodyTypeName(mutation.name, mutation.method, groupSize),
      schema: mutation.body,
      path: "$.mutations[" + entry.sourceIndex + "].body"
    });
  }

  return result;
}

function compileContracts(
  manifest: FluxFastSchemaManifest,
  reportUnsupported: boolean
): {
  contracts: CompiledContract[];
  diagnostics: ValidatorCompilationDiagnostic[];
} {
  const contracts = new Map<string, RootContract>();
  for (const contract of collectRootContracts(manifest)) {
    const existing = contracts.get(contract.name);
    if (
      existing &&
      canonicalJson(existing.schema) !== canonicalJson(contract.schema)
    ) {
      fail(
        contract.path,
        "validator contract " +
          contract.name +
          " collides with an incompatible definition at " +
          existing.path
      );
    }
    if (!existing) contracts.set(contract.name, contract);
  }

  const compiled: CompiledContract[] = [];
  const diagnostics: ValidatorCompilationDiagnostic[] = [];
  for (const contract of [...contracts.values()].sort((left, right) =>
    compareText(left.name, right.name)
  )) {
    try {
      compiled.push({
        name: contract.name,
        document: compileJsonSchemaToValidationPlan(contract.schema, contract.path)
      });
    } catch (error) {
      if (
        reportUnsupported &&
        error instanceof ValidatorCompilationError &&
        error.unsupported
      ) {
        diagnostics.push({
          contract: contract.name,
          path: error.path,
          ...(error.keyword === undefined ? {} : { keyword: error.keyword }),
          message: error.message
        });
        continue;
      }
      throw error;
    }
  }
  diagnostics.sort(
    (left, right) =>
      compareText(left.contract, right.contract) ||
      compareText(left.path, right.path) ||
      compareText(left.keyword ?? "", right.keyword ?? "") ||
      compareText(left.message, right.message)
  );
  return { contracts: compiled, diagnostics };
}

function hasUnsafeKey(key: string): boolean {
  return key === "__proto__" || key === "constructor" || key === "prototype";
}

function renderPlanValue(value: unknown, indent = 0): string {
  const pad = " ".repeat(indent);
  const childPad = " ".repeat(indent + 2);
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return (
      "[" +
      value
        .map(item => "\n" + childPad + renderPlanValue(item, indent + 2))
        .join(",") +
      "\n" +
      pad +
      "]"
    );
  }
  if (!isRecord(value)) {
    fail("$", "generated validation plan contains a non-JSON value");
  }
  const keys = Object.keys(value);
  if (keys.length === 0) return "{}";
  const entries = keys.map(key => ({
    key: JSON.stringify(key),
    value: renderPlanValue(value[key], indent + 2)
  }));
  if (keys.some(hasUnsafeKey)) {
    return (
      "Object.fromEntries([\n" +
      entries
        .map(entry => childPad + "[" + entry.key + ", " + entry.value + "]")
        .join(",\n") +
      "\n" +
      pad +
      "])"
    );
  }
  return (
    "{\n" +
    entries
      .map(entry => childPad + entry.key + ": " + entry.value)
      .join(",\n") +
    "\n" +
    pad +
    "}"
  );
}

function renderDiagnostics(
  diagnostics: readonly ValidatorCompilationDiagnostic[]
): string {
  if (diagnostics.length === 0) {
    return "export const validatorDiagnostics = [] as const;";
  }
  const entries = diagnostics.map(diagnostic => {
    const record: Record<string, string> = {
      contract: diagnostic.contract,
      path: diagnostic.path,
      message: diagnostic.message
    };
    if (diagnostic.keyword !== undefined) record.keyword = diagnostic.keyword;
    return "  " + renderPlanValue(record, 2);
  });
  return (
    "export const validatorDiagnostics = [\n" +
    entries.join(",\n") +
    "\n] as const;"
  );
}

function renderValidatorSource(
  manifest: FluxFastSchemaManifest,
  contracts: readonly CompiledContract[],
  diagnostics: readonly ValidatorCompilationDiagnostic[],
  includeDiagnostics: boolean
): string {
  const header = [
    "// AUTO-GENERATED BY FLUXFAST.",
    "// DO NOT EDIT MANUALLY.",
    "// Schema: " + manifest.schema,
    "// Producer: " + manifest.producer,
    "// Fingerprint: " + manifest.fingerprint
  ];
  if (contracts.length === 0) {
    return (
      header.join("\n") +
      "\n\n" +
      (includeDiagnostics ? renderDiagnostics(diagnostics) + "\n\n" : "") +
      "export const validators = {} as const;\n"
    );
  }

  const imports = [
    'import { createValidator } from "@fluxfast/core";',
    'import type { FluxValidator } from "@fluxfast/core";',
    "import type {",
    ...contracts.map(contract => "  " + contract.name + ","),
    '} from "./types.generated";'
  ].join("\n");
  const declarations = contracts.map(contract => {
    const plan = renderPlanValue(contract.document, 2);
    return (
      "export const " +
      contract.name +
      "Validator: FluxValidator<" +
      contract.name +
      "> = createValidator<" +
      contract.name +
      ">(\n" +
      plan +
      "\n);"
    );
  });
  const registryEntries = contracts.map(
    contract => "  " + contract.name + ": " + contract.name + "Validator,"
  );
  return (
    header.join("\n") +
    "\n\n" +
    imports +
    "\n\n" +
    (includeDiagnostics ? renderDiagnostics(diagnostics) + "\n\n" : "") +
    declarations.join("\n\n") +
    "\n\nexport const validators = {\n" +
    registryEntries.join("\n") +
    "\n} as const;\n"
  );
}

/**
 * Compile manifest schemas while retaining usable TypeScript output when one
 * contract contains an unsupported validation keyword. The omitted contract
 * is listed in `validatorDiagnostics` and is never represented by a weaker
 * validator.
 */
export function compileFluxFastValidatorsWithDiagnostics(
  value: unknown
): ValidatorCompilationResult {
  const manifest = validateFluxFastSchemaManifest(value);
  const result = compileContracts(manifest, true);
  return {
    content: renderValidatorSource(
      manifest,
      result.contracts,
      result.diagnostics,
      true
    ),
    diagnostics: Object.freeze([...result.diagnostics])
  };
}

/** Compile manifest JSON Schemas into tree-shakeable generated validators. */
export function compileFluxFastValidators(
  value: unknown,
  options: ValidatorCompilationOptions = {}
): string {
  if (options.unsupported === "report") {
    return compileFluxFastValidatorsWithDiagnostics(value).content;
  }
  const manifest = validateFluxFastSchemaManifest(value);
  const result = compileContracts(manifest, false);
  return renderValidatorSource(manifest, result.contracts, [], false);
}
