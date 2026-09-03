import {
  type FluxFastMutationRouteSchema,
  type FluxFastSchemaManifest,
  type JsonSchema,
  type JsonValue,
  validateFluxFastSchemaManifest
} from "./schema-manifest.js";

type SchemaNode = JsonSchema | boolean;

interface CompilationContext {
  references: Map<string, string>;
  resourceAlias: string;
  resourceKey: string;
  rootType?: string;
}

interface NamedDefinition {
  context: CompilationContext;
  name: string;
  path: string;
  schema: SchemaNode;
  signature: string;
}

interface ResourceAlias {
  context: CompilationContext;
  name: string;
  path: string;
  schema: JsonSchema;
}

interface UnknownAnalysis {
  readonly containsUnknown: boolean;
  readonly kind: "never" | "other" | "unknown";
  readonly references: ReadonlySet<string>;
}

const NEVER_ANALYSIS: UnknownAnalysis = {
  containsUnknown: false,
  kind: "never",
  references: new Set()
};
const OTHER_ANALYSIS: UnknownAnalysis = {
  containsUnknown: false,
  kind: "other",
  references: new Set()
};
const UNKNOWN_ANALYSIS: UnknownAnalysis = {
  containsUnknown: true,
  kind: "unknown",
  references: new Set()
};

function mergeReferences(
  analyses: readonly UnknownAnalysis[]
): ReadonlySet<string> {
  const references = new Set<string>();
  for (const analysis of analyses) {
    for (const name of analysis.references) references.add(name);
  }
  return references;
}

function otherUnknownAnalysis(
  analyses: readonly UnknownAnalysis[]
): UnknownAnalysis {
  const containsUnknown = analyses.some(analysis => analysis.containsUnknown);
  const references = mergeReferences(analyses);
  if (!containsUnknown && references.size === 0) return OTHER_ANALYSIS;
  return { containsUnknown, kind: "other", references };
}

function unionUnknownAnalysis(
  analyses: readonly UnknownAnalysis[]
): UnknownAnalysis {
  const members = analyses.filter(analysis => analysis.kind !== "never");
  if (
    members.length === 0 ||
    members.some(analysis => analysis.kind === "unknown")
  ) {
    return UNKNOWN_ANALYSIS;
  }
  return otherUnknownAnalysis(members);
}

function intersectionUnknownAnalysis(
  analyses: readonly UnknownAnalysis[]
): UnknownAnalysis {
  if (analyses.some(analysis => analysis.kind === "never")) {
    return NEVER_ANALYSIS;
  }
  const members = analyses.filter(analysis => analysis.kind !== "unknown");
  if (members.length === 0) return UNKNOWN_ANALYSIS;
  return otherUnknownAnalysis(members);
}

/** A deterministic code-generation error tied to one manifest location. */
export class SchemaCompilationError extends TypeError {
  readonly path: string;

  constructor(path: string, reason: string) {
    super(`[fluxfast] Could not compile schema at ${path}: ${reason}`);
    this.name = "SchemaCompilationError";
    this.path = path;
  }
}

function fail(path: string, reason: string): never {
  throw new SchemaCompilationError(path, reason);
}

function isRecord(value: JsonValue | undefined): value is JsonSchema {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonicalJson(value: JsonValue): string {
  if (Array.isArray(value)) {
    return `[${value.map(item => canonicalJson(item)).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function referencedTypeSignature(
  schema: SchemaNode,
  context: CompilationContext
): string {
  if (typeof schema === "boolean") return canonicalJson(schema);
  const references: string[] = [];
  const pending: JsonValue[] = [schema];
  while (pending.length > 0) {
    const value = pending.pop()!;
    if (Array.isArray(value)) {
      pending.push(...value);
      continue;
    }
    if (!isRecord(value)) continue;
    if (typeof value.$ref === "string") {
      references.push(
        `${value.$ref}:${context.references.get(
          decodeReferenceKey(value.$ref)
        ) ?? "?"}`
      );
    }
    pending.push(...Object.values(value));
  }
  references.sort();
  return `${canonicalJson(schema)}|${references.join("|")}`;
}

function shortFingerprint(value: string): string {
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.codePointAt(0)!;
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function pascalIdentifier(value: string, fallback: string): string {
  const words = value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .match(/[A-Za-z0-9]+/g);
  let identifier = words
    ?.map(word => `${word[0].toUpperCase()}${word.slice(1)}`)
    .join("");
  if (!identifier) {
    identifier = `${fallback}${shortFingerprint(value)}`;
  }
  if (/^[0-9]/.test(identifier)) {
    identifier = `Type${identifier}`;
  }
  return identifier;
}

export function camelIdentifier(value: string): string {
  const identifier = pascalIdentifier(value, "ResourceKey");
  return `${identifier[0].toLowerCase()}${identifier.slice(1)}`;
}

/** Derive the same stable identifier used by generated mutation helpers. */
export function mutationOperationIdentifier(
  name: string,
  method: string,
  groupSize: number
): string {
  return groupSize > 1
    ? camelIdentifier(`${name}_${method.toLowerCase()}`)
    : camelIdentifier(name);
}

/** Derive the reusable generated contract name for one mutation body. */
export function mutationBodyTypeName(
  name: string,
  method: string,
  groupSize: number
): string {
  return `${pascalIdentifier(
    mutationOperationIdentifier(name, method, groupSize),
    "Mutation"
  )}Body`;
}

/** Compile one validated JSON Schema as a self-contained TypeScript expression. */
export function compileInlineJsonSchemaType(
  schema: JsonSchema,
  path = "$"
): string {
  const definitions = new Map<string, { path: string; schema: SchemaNode }>();
  for (const keyword of ["$defs", "definitions"] as const) {
    if (schema[keyword] === undefined) continue;
    const entries = schemaMap(schema[keyword], `${path}.${keyword}`);
    for (const key of Object.keys(entries).sort()) {
      const definition = entries[key];
      const definitionPath = childPath(`${path}.${keyword}`, key);
      const existing = definitions.get(key);
      if (
        existing &&
        canonicalJson(existing.schema) !== canonicalJson(definition)
      ) {
        fail(
          definitionPath,
          `definition ${JSON.stringify(key)} is declared more than once`
        );
      }
      definitions.set(key, { path: definitionPath, schema: definition });
    }
  }

  const context: CompilationContext = {
    references: new Map(),
    resourceAlias: "unknown",
    resourceKey: "inline"
  };
  const visiting = new Set<string>();

  const referencedDefinitions = (value: SchemaNode): string[] => {
    if (typeof value === "boolean") return [];
    const references = new Set<string>();
    const pending: JsonValue[] = [value];
    while (pending.length > 0) {
      const item = pending.pop()!;
      if (Array.isArray(item)) {
        pending.push(...item);
        continue;
      }
      if (!isRecord(item)) continue;
      if (typeof item.$ref === "string") {
        const key = decodeReferenceKey(item.$ref);
        if (definitions.has(key)) references.add(key);
      }
      pending.push(...Object.values(item));
    }
    return [...references].sort();
  };

  const resolveDefinition = (key: string): void => {
    if (context.references.has(key)) return;
    const definition = definitions.get(key);
    if (!definition) return;
    if (visiting.has(key)) {
      fail(
        definition.path,
        `recursive definition ${JSON.stringify(key)} cannot be used as an inline route parameter`
      );
    }
    visiting.add(key);
    for (const dependency of referencedDefinitions(definition.schema)) {
      resolveDefinition(dependency);
    }
    context.references.set(
      key,
      compileSchema(definition.schema, context, definition.path)
    );
    visiting.delete(key);
  };

  for (const key of [...definitions.keys()].sort()) {
    resolveDefinition(key);
  }
  return compileSchema(schema, context, path);
}

function propertyName(value: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value)
    ? value
    : JSON.stringify(value);
}

function childPath(path: string, key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)
    ? `${path}.${key}`
    : `${path}[${JSON.stringify(key)}]`;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function schemaRecord(value: JsonValue | undefined, path: string): JsonSchema {
  if (!isRecord(value)) {
    fail(path, "expected a JSON Schema object");
  }
  return value;
}

function schemaArray(value: JsonValue | undefined, path: string): SchemaNode[] {
  if (!Array.isArray(value)) {
    fail(path, "expected an array of JSON Schemas");
  }
  return value.map((item, index) => {
    if (typeof item === "boolean") return item;
    return schemaRecord(item, `${path}[${index}]`);
  });
}

function schemaMap(
  value: JsonValue | undefined,
  path: string
): Record<string, SchemaNode> {
  const record = schemaRecord(value, path);
  const result = Object.create(null) as Record<string, SchemaNode>;
  for (const key of Object.keys(record)) {
    const item = record[key];
    if (typeof item === "boolean") {
      result[key] = item;
    } else {
      result[key] = schemaRecord(item, childPath(path, key));
    }
  }
  return result;
}

function union(types: string[]): string {
  const values = [...new Set(types)].filter(type => type !== "never");
  if (values.includes("unknown") || values.length === 0) return "unknown";
  return values.length === 1 ? values[0] : values.join(" | ");
}

function intersection(types: string[]): string {
  if (types.includes("never")) return "never";
  const values = [...new Set(types)].filter(type => type !== "unknown");
  if (values.length === 0) return "unknown";
  return values.length === 1
    ? values[0]
    : values.map(type => (type.includes(" | ") ? `(${type})` : type)).join(" & ");
}

function arrayElement(type: string): string {
  return type.includes(" | ") || type.includes(" & ") ? `(${type})` : type;
}

function literalType(value: JsonValue): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(item => literalType(item)).join(", ")}]`;
  }
  const properties = Object.keys(value)
    .sort()
    .map(key => `${propertyName(key)}: ${literalType(value[key])}`);
  return `{ ${properties.join("; ")} }`;
}

function decodeReferenceSegment(value: string, path: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    fail(path, `contains invalid URI escaping: ${JSON.stringify(value)}`);
  }
  if (decoded.includes("/")) {
    fail(path, `must point directly to a local definition; received ${JSON.stringify(value)}`);
  }
  if (/~(?:[^01]|$)/.test(decoded)) {
    fail(path, `contains invalid JSON Pointer escaping: ${JSON.stringify(value)}`);
  }
  return decoded.replace(/~1/g, "/").replace(/~0/g, "~");
}

function decodeReferenceKey(reference: string): string {
  const prefix = ["#/$defs/", "#/definitions/"].find(candidate =>
    reference.startsWith(candidate)
  );
  if (!prefix) return reference;
  const value = reference.slice(prefix.length);
  try {
    return decodeURIComponent(value).replace(/~1/g, "/").replace(/~0/g, "~");
  } catch {
    return value;
  }
}

function resolveReference(
  reference: string,
  context: CompilationContext,
  path: string
): string {
  if (reference === "#") {
    return context.rootType ?? context.resourceAlias;
  }
  const prefixes = ["#/$defs/", "#/definitions/"];
  const prefix = prefixes.find(candidate => reference.startsWith(candidate));
  if (!prefix) {
    fail(path, `only local $defs references are supported; received ${JSON.stringify(reference)}`);
  }
  const remainder = reference.slice(prefix.length);
  if (!remainder || remainder.includes("/")) {
    fail(path, `must point directly to a local definition; received ${JSON.stringify(reference)}`);
  }
  const key = decodeReferenceSegment(remainder, path);
  const name = context.references.get(key);
  if (!name) {
    fail(path, `references unknown definition ${JSON.stringify(key)}`);
  }
  return name;
}

function compileObject(
  schema: JsonSchema,
  context: CompilationContext,
  path: string,
  multiline: boolean
): string {
  const properties = schema.properties === undefined
    ? {}
    : schemaMap(schema.properties, `${path}.properties`);
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((item): item is string => typeof item === "string")
      : []
  );
  const propertyEntries = Object.keys(properties)
    .sort()
    .map(key => {
      const type = compileSchema(
        properties[key],
        context,
        childPath(`${path}.properties`, key)
      );
      return `${propertyName(key)}${required.has(key) ? "" : "?"}: ${type};`;
    });

  const additional = schema.additionalProperties;
  let indexType: string | undefined;
  if (additional === true) {
    indexType = "unknown";
  } else if (isRecord(additional)) {
    indexType = compileSchema(
      additional,
      context,
      `${path}.additionalProperties`
    );
    if (propertyEntries.length > 0) {
      indexType = "unknown";
    }
  }

  if (indexType) {
    propertyEntries.push(`[key: string]: ${indexType};`);
  }
  if (propertyEntries.length === 0) {
    propertyEntries.push("[key: string]: never;");
  }

  if (!multiline) {
    return `{ ${propertyEntries.join(" ")} }`;
  }
  return `{\n${propertyEntries.map(entry => `  ${entry}`).join("\n")}\n}`;
}

function compileArray(
  schema: JsonSchema,
  context: CompilationContext,
  path: string
): string {
  if (schema.prefixItems !== undefined) {
    const prefixItems = schemaArray(schema.prefixItems, `${path}.prefixItems`);
    const members = prefixItems.map((item, index) =>
      compileSchema(item, context, `${path}.prefixItems[${index}]`)
    );
    if (schema.items === false || schema.items === undefined) {
      return `[${members.join(", ")}]`;
    }
    const rest = schema.items === true
      ? "unknown"
      : compileSchema(
          schemaRecord(schema.items, `${path}.items`),
          context,
          `${path}.items`
        );
    return `[${members.join(", ")}${members.length > 0 ? ", " : ""}...${arrayElement(rest)}[]]`;
  }

  if (schema.items === false) return "[]";
  if (schema.items === undefined || schema.items === true) return "unknown[]";
  const item = compileSchema(
    schemaRecord(schema.items, `${path}.items`),
    context,
    `${path}.items`
  );
  return `${arrayElement(item)}[]`;
}

function compileExplicitType(
  type: string,
  schema: JsonSchema,
  context: CompilationContext,
  path: string
): string {
  if (type === "null") return "null";
  if (type === "boolean") return "boolean";
  if (type === "integer" || type === "number") return "number";
  if (type === "string") return "string";
  if (type === "array") return compileArray(schema, context, path);
  if (type === "object") return compileObject(schema, context, path, false);
  return "unknown";
}

function compileSchema(
  schema: SchemaNode,
  context: CompilationContext,
  path: string
): string {
  if (schema === true) return "unknown";
  if (schema === false) return "never";

  const parts: string[] = [];
  if (typeof schema.$ref === "string") {
    parts.push(resolveReference(schema.$ref, context, `${path}.$ref`));
  }
  if (schema.const !== undefined) {
    parts.push(literalType(schema.const));
  } else if (Array.isArray(schema.enum)) {
    parts.push(union(schema.enum.map(item => literalType(item))));
  }

  for (const keyword of ["anyOf", "oneOf"] as const) {
    if (schema[keyword] !== undefined) {
      const alternatives = schemaArray(schema[keyword], `${path}.${keyword}`);
      parts.push(
        union(
          alternatives.map((item, index) =>
            compileSchema(item, context, `${path}.${keyword}[${index}]`)
          )
        )
      );
    }
  }
  if (schema.allOf !== undefined) {
    const members = schemaArray(schema.allOf, `${path}.allOf`);
    parts.push(
      intersection(
        members.map((item, index) =>
          compileSchema(item, context, `${path}.allOf[${index}]`)
        )
      )
    );
  }

  if (schema.const === undefined && schema.enum === undefined) {
    const explicitTypes = Array.isArray(schema.type)
      ? schema.type.filter((item): item is string => typeof item === "string")
      : typeof schema.type === "string"
        ? [schema.type]
        : [];
    if (explicitTypes.length > 0) {
      parts.push(
        union(
          explicitTypes.map(type =>
            compileExplicitType(type, schema, context, path)
          )
        )
      );
    } else if (
      schema.properties !== undefined ||
      schema.additionalProperties !== undefined
    ) {
      parts.push(compileObject(schema, context, path, false));
    } else if (schema.items !== undefined || schema.prefixItems !== undefined) {
      parts.push(compileArray(schema, context, path));
    }
  }

  if (schema.nullable === true) {
    return union([intersection(parts), "null"]);
  }
  return intersection(parts);
}

function canRenderInterface(schema: JsonSchema): boolean {
  const type = schema.type;
  const isObject = type === "object" ||
    (type === undefined && schema.properties !== undefined);
  return isObject &&
    schema.$ref === undefined &&
    schema.const === undefined &&
    schema.enum === undefined &&
    schema.anyOf === undefined &&
    schema.oneOf === undefined &&
    schema.allOf === undefined &&
    schema.nullable !== true;
}

class ResourceTypeCompiler {
  private readonly definitions = new Map<string, NamedDefinition>();
  private readonly explicitContracts: ResourceAlias[] = [];
  private readonly explicitTypeNames = new Map<string, string>();
  private readonly mutationContracts: ResourceAlias[] = [];
  private readonly resourceKeyNames = new Map<string, string>();
  private readonly resourceNames = new Map<string, string>();
  private readonly resources: ResourceAlias[] = [];
  private unknownDefinitions?: ReadonlySet<string>;

  constructor(private readonly manifest: FluxFastSchemaManifest) {}

  compile(): string {
    this.collectExplicitTypes();
    this.collectResources();
    this.collectMutationBodies();
    const resources = [...this.resources].sort((left, right) =>
      compareText(left.context.resourceKey, right.context.resourceKey)
    );
    const declarations = [
      this.renderResourceKeys(resources),
      ...[...this.definitions.values()]
        .sort((left, right) => compareText(left.name, right.name))
        .map(definition => this.renderDefinition(definition)),
      ...resources.map(resource => {
        const type = resource.context.rootType ?? compileSchema(
          resource.schema,
          resource.context,
          resource.path
        );
        return `export type ${resource.name} = ${type};`;
      }),
      this.renderResourceMap(resources),
      this.renderResourceMapAugmentation(resources)
    ];

    const header = [
      "// AUTO-GENERATED BY FLUXFAST.",
      "// DO NOT EDIT MANUALLY.",
      `// Schema: ${this.manifest.schema}`,
      `// Producer: ${this.manifest.producer}`,
      `// Fingerprint: ${this.manifest.fingerprint}`
    ];
    return `${header.join("\n")}\n\nimport type {} from "@fluxfast/core";\n\n${declarations.join("\n\n")}\n`;
  }

  resourcesWithUnknownTypes(): string[] {
    this.collectResources();
    return [...this.resources]
      .sort((left, right) =>
        compareText(left.context.resourceKey, right.context.resourceKey)
      )
      .filter(resource =>
        this.schemaContainsUnknown(
          resource.schema,
          resource.context,
          resource.path
        )
      )
      .map(resource => resource.context.resourceKey);
  }

  contractsWithUnknownTypes(): string[] {
    this.collectExplicitTypes();
    this.collectResources();
    this.collectMutationBodies();
    const contracts = new Map<string, ResourceAlias>();
    for (const contract of [
      ...this.explicitContracts,
      ...this.resources,
      ...this.mutationContracts
    ]) {
      if (!contracts.has(contract.name)) contracts.set(contract.name, contract);
    }
    return [...contracts.values()]
      .sort(
        (left, right) =>
          compareText(left.name, right.name) || compareText(left.path, right.path)
      )
      .filter(contract =>
        this.schemaContainsUnknown(
          contract.schema,
          contract.context,
          contract.path
        )
      )
      .map(contract => contract.name);
  }

  private schemaContainsUnknown(
    schema: SchemaNode,
    context: CompilationContext,
    path: string
  ): boolean {
    const analysis = this.analyzeUnknown(schema, context, path);
    if (analysis.containsUnknown) return true;
    const unknownDefinitions = this.findUnknownDefinitions();
    return [...analysis.references].some(name => unknownDefinitions.has(name));
  }

  private findUnknownDefinitions(): ReadonlySet<string> {
    if (this.unknownDefinitions) return this.unknownDefinitions;

    const analyses = new Map<string, UnknownAnalysis>();
    const dependents = new Map<string, Set<string>>();
    const unknown = new Set<string>();
    for (const definition of this.definitions.values()) {
      const analysis = this.analyzeUnknown(
        definition.schema,
        definition.context,
        definition.path
      );
      analyses.set(definition.name, analysis);
      if (analysis.containsUnknown) unknown.add(definition.name);
    }
    for (const [name, analysis] of analyses) {
      for (const dependency of analysis.references) {
        if (!analyses.has(dependency)) continue;
        let names = dependents.get(dependency);
        if (!names) {
          names = new Set();
          dependents.set(dependency, names);
        }
        names.add(name);
      }
    }

    const pending = [...unknown];
    for (let index = 0; index < pending.length; index += 1) {
      for (const dependent of dependents.get(pending[index]) ?? []) {
        if (unknown.has(dependent)) continue;
        unknown.add(dependent);
        pending.push(dependent);
      }
    }
    this.unknownDefinitions = unknown;
    return unknown;
  }

  private analyzeUnknown(
    schema: SchemaNode,
    context: CompilationContext,
    path: string
  ): UnknownAnalysis {
    if (schema === true) return UNKNOWN_ANALYSIS;
    if (schema === false) return NEVER_ANALYSIS;

    const parts: UnknownAnalysis[] = [];
    if (typeof schema.$ref === "string") {
      const name = resolveReference(schema.$ref, context, `${path}.$ref`);
      parts.push({
        containsUnknown: false,
        kind: "other",
        references: new Set([name])
      });
    }

    if (schema.const !== undefined) {
      parts.push(OTHER_ANALYSIS);
    } else if (Array.isArray(schema.enum)) {
      parts.push(
        unionUnknownAnalysis(schema.enum.map(() => OTHER_ANALYSIS))
      );
    }

    for (const keyword of ["anyOf", "oneOf"] as const) {
      if (schema[keyword] === undefined) continue;
      const alternatives = schemaArray(schema[keyword], `${path}.${keyword}`);
      parts.push(
        unionUnknownAnalysis(
          alternatives.map((item, index) =>
            this.analyzeUnknown(
              item,
              context,
              `${path}.${keyword}[${index}]`
            )
          )
        )
      );
    }
    if (schema.allOf !== undefined) {
      const members = schemaArray(schema.allOf, `${path}.allOf`);
      parts.push(
        intersectionUnknownAnalysis(
          members.map((item, index) =>
            this.analyzeUnknown(
              item,
              context,
              `${path}.allOf[${index}]`
            )
          )
        )
      );
    }

    if (schema.const === undefined && schema.enum === undefined) {
      const explicitTypes = Array.isArray(schema.type)
        ? schema.type.filter((item): item is string => typeof item === "string")
        : typeof schema.type === "string"
          ? [schema.type]
          : [];
      if (explicitTypes.length > 0) {
        parts.push(
          unionUnknownAnalysis(
            explicitTypes.map(type =>
              this.analyzeExplicitTypeUnknown(
                type,
                schema,
                context,
                path
              )
            )
          )
        );
      } else if (
        schema.properties !== undefined ||
        schema.additionalProperties !== undefined
      ) {
        parts.push(
          this.analyzeObjectUnknown(
            schema,
            context,
            path
          )
        );
      } else if (schema.items !== undefined || schema.prefixItems !== undefined) {
        parts.push(
          this.analyzeArrayUnknown(
            schema,
            context,
            path
          )
        );
      }
    }

    const result = intersectionUnknownAnalysis(parts);
    return schema.nullable === true
      ? unionUnknownAnalysis([result, OTHER_ANALYSIS])
      : result;
  }

  private analyzeExplicitTypeUnknown(
    type: string,
    schema: JsonSchema,
    context: CompilationContext,
    path: string
  ): UnknownAnalysis {
    if (type === "array") {
      return this.analyzeArrayUnknown(
        schema,
        context,
        path
      );
    }
    if (type === "object") {
      return this.analyzeObjectUnknown(
        schema,
        context,
        path
      );
    }
    return ["null", "boolean", "integer", "number", "string"].includes(type)
      ? OTHER_ANALYSIS
      : UNKNOWN_ANALYSIS;
  }

  private analyzeObjectUnknown(
    schema: JsonSchema,
    context: CompilationContext,
    path: string
  ): UnknownAnalysis {
    const properties = schema.properties === undefined
      ? {}
      : schemaMap(schema.properties, `${path}.properties`);
    const propertyAnalyses = Object.keys(properties)
      .sort()
      .map(key =>
        this.analyzeUnknown(
          properties[key],
          context,
          childPath(`${path}.properties`, key)
        )
      );

    const additional = schema.additionalProperties;
    let additionalAnalysis: UnknownAnalysis | undefined;
    if (additional === true) {
      additionalAnalysis = UNKNOWN_ANALYSIS;
    } else if (isRecord(additional)) {
      additionalAnalysis = this.analyzeUnknown(
        additional,
        context,
        `${path}.additionalProperties`
      );
      if (propertyAnalyses.length > 0) additionalAnalysis = UNKNOWN_ANALYSIS;
    }

    return otherUnknownAnalysis(
      [...propertyAnalyses, additionalAnalysis].filter(
        (analysis): analysis is UnknownAnalysis => analysis !== undefined
      )
    );
  }

  private analyzeArrayUnknown(
    schema: JsonSchema,
    context: CompilationContext,
    path: string
  ): UnknownAnalysis {
    const analyses: UnknownAnalysis[] = [];
    if (schema.prefixItems !== undefined) {
      const prefixItems = schemaArray(schema.prefixItems, `${path}.prefixItems`);
      analyses.push(
        ...prefixItems.map((item, index) =>
          this.analyzeUnknown(
            item,
            context,
            `${path}.prefixItems[${index}]`
          )
        )
      );
      if (schema.items === true) {
        analyses.push(UNKNOWN_ANALYSIS);
      } else if (isRecord(schema.items)) {
        analyses.push(
          this.analyzeUnknown(
            schema.items,
            context,
            `${path}.items`
          )
        );
      }
    } else if (schema.items === undefined || schema.items === true) {
      analyses.push(UNKNOWN_ANALYSIS);
    } else if (isRecord(schema.items)) {
      analyses.push(
        this.analyzeUnknown(
          schema.items,
          context,
          `${path}.items`
        )
      );
    }

    return otherUnknownAnalysis(analyses);
  }

  private renderResourceKeys(resources: ResourceAlias[]): string {
    if (resources.length === 0) {
      return "export const resourceKeys = {} as const;";
    }
    const entries = resources.map(resource => {
      const resourceKey = resource.context.resourceKey;
      return `  ${camelIdentifier(resourceKey)}: ${JSON.stringify(resourceKey)},`;
    });
    return `export const resourceKeys = {\n${entries.join("\n")}\n} as const;`;
  }

  private renderResourceMap(resources: ResourceAlias[]): string {
    if (resources.length === 0) {
      return "export interface GeneratedFluxResourceMap {}";
    }
    const entries = resources.map(
      resource => `  ${propertyName(resource.context.resourceKey)}: ${resource.name};`
    );
    return `export interface GeneratedFluxResourceMap {\n${entries.join("\n")}\n}`;
  }

  private renderResourceMapAugmentation(resources: ResourceAlias[]): string {
    if (resources.length === 0) {
      return 'declare module "@fluxfast/core" {\n  interface FluxResourceMap {}\n}';
    }
    const entries = resources.map(
      resource => `    ${propertyName(resource.context.resourceKey)}: ${resource.name};`
    );
    return `declare module "@fluxfast/core" {\n  interface FluxResourceMap {\n${entries.join("\n")}\n  }\n}`;
  }

  private collectResources(): void {
    for (const resourceKey of Object.keys(this.manifest.resources).sort()) {
      const resourcePath = childPath("$.resources", resourceKey);
      const path = `${resourcePath}.schema`;
      const schema = this.manifest.resources[resourceKey].schema;
      const keyName = camelIdentifier(resourceKey);
      const existingKey = this.resourceKeyNames.get(keyName);
      if (existingKey !== undefined) {
        fail(
          resourcePath,
          `resource key ${JSON.stringify(resourceKey)} collides with ${JSON.stringify(
            existingKey
          )} as TypeScript constant resourceKeys.${keyName}`
        );
      }
      this.resourceKeyNames.set(keyName, resourceKey);
      const alias = `${pascalIdentifier(resourceKey, "Resource")}Resource`;
      const existingResource = this.resourceNames.get(alias);
      if (existingResource) {
        fail(
          resourcePath,
          `resource key ${JSON.stringify(resourceKey)} collides with ${JSON.stringify(
            existingResource
          )} as TypeScript name ${alias}`
        );
      }
      const existingDefinition = this.definitions.get(alias);
      if (existingDefinition) {
        fail(
          resourcePath,
          `generated resource type ${alias} collides with model at ${existingDefinition.path}`
        );
      }
      this.resourceNames.set(alias, resourceKey);

      const context: CompilationContext = {
        references: new Map(),
        resourceAlias: alias,
        resourceKey
      };
      this.collectDefinitions(schema, context, path);
      const title = typeof schema.title === "string" && schema.title.trim()
        ? schema.title
        : undefined;
      if (title) {
        const rootType = pascalIdentifier(title, "Model");
        context.rootType = rootType;
        this.registerDefinition(rootType, schema, context, path);
      }
      this.resources.push({ context, name: alias, path, schema });
    }
  }

  private collectMutationBodies(): void {
    const mutations = this.manifest.mutations
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
    for (const { mutation } of mutations) {
      const key = `${mutation.name}\u0000${mutation.path}`;
      groupSizes.set(key, (groupSizes.get(key) ?? 0) + 1);
    }
    const bodyNames = new Map<string, string>();

    for (const { mutation, sourceIndex } of mutations) {
      const groupKey = `${mutation.name}\u0000${mutation.path}`;
      const bodyName = mutationBodyTypeName(
        mutation.name,
        mutation.method,
        groupSizes.get(groupKey)!
      );
      const bodyPath = `$.mutations[${sourceIndex}].body`;
      const existing = bodyNames.get(bodyName);
      if (existing) {
        fail(
          bodyPath,
          `mutation body ${JSON.stringify(mutation.name)} collides with ${JSON.stringify(
            existing
          )} as TypeScript name ${bodyName}`
        );
      }
      bodyNames.set(bodyName, mutation.name);

      const context: CompilationContext = {
        references: new Map(),
        resourceAlias: bodyName,
        resourceKey: mutation.name,
        rootType: bodyName
      };
      this.collectDefinitions(mutation.body, context, bodyPath);
      this.registerDefinition(bodyName, mutation.body, context, bodyPath);
      this.mutationContracts.push({
        context,
        name: bodyName,
        path: bodyPath,
        schema: mutation.body
      });
    }
  }

  private collectExplicitTypes(): void {
    for (const typeName of Object.keys(this.manifest.types ?? {}).sort()) {
      const typePath = childPath("$.types", typeName);
      const schemaPath = `${typePath}.schema`;
      const schema = this.manifest.types![typeName].schema;
      const generatedName = pascalIdentifier(typeName, "Type");
      const existingName = this.explicitTypeNames.get(generatedName);
      if (existingName !== undefined) {
        fail(
          typePath,
          `type contract ${JSON.stringify(typeName)} collides with ${JSON.stringify(
            existingName
          )} as TypeScript name ${generatedName}`
        );
      }
      this.explicitTypeNames.set(generatedName, typeName);

      const context: CompilationContext = {
        references: new Map(),
        resourceAlias: generatedName,
        resourceKey: typeName,
        rootType: generatedName
      };
      this.collectDefinitions(schema, context, schemaPath);
      this.registerDefinition(generatedName, schema, context, schemaPath);
      this.explicitContracts.push({
        context,
        name: generatedName,
        path: schemaPath,
        schema
      });
    }
  }

  private collectDefinitions(
    schema: JsonSchema,
    context: CompilationContext,
    path: string
  ): void {
    const local = new Map<string, { path: string; schema: SchemaNode }>();
    for (const keyword of ["$defs", "definitions"] as const) {
      if (schema[keyword] === undefined) continue;
      const definitions = schemaMap(schema[keyword], `${path}.${keyword}`);
      for (const key of Object.keys(definitions).sort()) {
        const definition = definitions[key];
        const definitionPath = childPath(`${path}.${keyword}`, key);
        const existing = local.get(key);
        if (existing && canonicalJson(existing.schema) !== canonicalJson(definition)) {
          fail(definitionPath, `definition ${JSON.stringify(key)} is declared more than once`);
        }
        local.set(key, { path: definitionPath, schema: definition });
      }
    }

    for (const [key, definition] of local) {
      const sourceName = typeof definition.schema !== "boolean" &&
        typeof definition.schema.title === "string" &&
        definition.schema.title.trim()
          ? definition.schema.title
          : key;
      const name = pascalIdentifier(sourceName, "Model");
      context.references.set(key, name);
    }
    for (const [key, definition] of local) {
      this.registerDefinition(
        context.references.get(key)!,
        definition.schema,
        context,
        definition.path
      );
    }
  }

  private registerDefinition(
    name: string,
    schema: SchemaNode,
    context: CompilationContext,
    path: string
  ): void {
    const resource = this.resourceNames.get(name);
    if (resource) {
      fail(
        path,
        `model name ${name} collides with generated resource type for ${JSON.stringify(resource)}`
      );
    }
    const signature = referencedTypeSignature(schema, context);
    const existing = this.definitions.get(name);
    if (existing) {
      if (existing.signature !== signature) {
        fail(
          path,
          `model name ${name} collides with an incompatible definition at ${existing.path}`
        );
      }
      return;
    }
    this.definitions.set(name, { context, name, path, schema, signature });
  }

  private renderDefinition(definition: NamedDefinition): string {
    if (typeof definition.schema !== "boolean" && canRenderInterface(definition.schema)) {
      return `export interface ${definition.name} ${compileObject(
        definition.schema,
        definition.context,
        definition.path,
        true
      )}`;
    }
    return `export type ${definition.name} = ${compileSchema(
      definition.schema,
      definition.context,
      definition.path
    )};`;
  }
}

/** Compile validated FluxFast schemas into deterministic TypeScript contracts. */
export function compileFluxFastTypes(value: unknown): string {
  const manifest = validateFluxFastSchemaManifest(value);
  return new ResourceTypeCompiler(manifest).compile();
}

/**
 * Compile validated resource schemas into deterministic TypeScript.
 *
 * This compatibility name now also emits explicit application contracts from
 * schema/2 manifests; existing resource-only callers keep their old output.
 */
export function compileFluxFastResourceTypes(value: unknown): string {
  return compileFluxFastTypes(value);
}

/** Find resource contracts whose generated TypeScript contains `unknown`. */
export function findFluxFastResourceKeysWithUnknownTypes(
  value: unknown
): string[] {
  const manifest = validateFluxFastSchemaManifest(value);
  return new ResourceTypeCompiler(manifest).resourcesWithUnknownTypes();
}

/** Find generated root contracts whose TypeScript includes `unknown`. */
export function findFluxFastContractsWithUnknownTypes(
  value: unknown
): string[] {
  const manifest = validateFluxFastSchemaManifest(value);
  return new ResourceTypeCompiler(manifest).contractsWithUnknownTypes();
}
