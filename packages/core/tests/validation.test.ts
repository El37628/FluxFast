import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_VALIDATION_MAX_OPERATIONS,
  ValidationError,
  createValidationIssue,
  createValidator,
  formatValidationPath,
  refineValidator,
  type ValidationPlan
} from "../src";

interface ValidationPatternCases {
  accepted: Array<{ pattern: string; valid: string; invalid: string }>;
  rejected: string[];
}

const validationPatternCases = JSON.parse(
  fs.readFileSync(
    path.resolve(__dirname, "../../../tests/fixtures/validation-pattern-cases.json"),
    "utf8"
  )
) as ValidationPatternCases;

describe("FluxFast validation runtime", () => {
  it("validates primitives and exposes the result, guard, and assertion APIs", () => {
    const validator = createValidator<number>({
      kind: "integer",
      minimum: 1,
      maximum: 3
    });

    const valid = validator.validate(2);
    expect(valid).toEqual({ valid: true, value: 2, issues: [] });
    expect(validator.is(3)).toBe(true);
    expect(validator.is(3.5)).toBe(false);
    expect(validator.assert(1)).toBe(1);
    expect(validator.validate(4)).toMatchObject({
      valid: false,
      issues: [{ path: [], code: "maximum" }]
    });
    expect(() => validator.assert(4)).toThrow(ValidationError);
  });

  it("composes a synchronous refinement after generated validation", () => {
    const base = createValidator<{
      password: string;
      confirmPassword: string;
    }>({
      kind: "object",
      properties: {
        password: { kind: "string", minLength: 8 },
        confirmPassword: { kind: "string", minLength: 8 }
      },
      required: ["password", "confirmPassword"]
    });
    let calls = 0;
    const validator = refineValidator(base, value => {
      calls += 1;
      if (value.password !== value.confirmPassword) {
        return {
          path: ["confirmPassword"],
          code: "password_mismatch",
          message: "Passwords do not match"
        };
      }
      return null;
    });

    expect(validator.is({ password: "correct horse", confirmPassword: "correct horse" })).toBe(true);
    expect(validator.validate({ password: "correct horse", confirmPassword: "different" })).toEqual({
      valid: false,
      issues: [{
        path: ["confirmPassword"],
        code: "password_mismatch",
        message: "Passwords do not match"
      }]
    });
    expect(() => validator.assert({
      password: "correct horse",
      confirmPassword: "different"
    })).toThrow(ValidationError);
    expect(calls).toBe(3);

    const invalidBase = validator.validate({ password: "short", confirmPassword: "different" });
    expect(invalidBase).toMatchObject({
      valid: false,
      issues: [expect.objectContaining({ code: "minLength" })]
    });
    expect(calls).toBe(3);
  });

  it("freezes refinement issues and supports chained refinements", () => {
    const base = createValidator<{ value: number }>({
      kind: "object",
      properties: { value: { kind: "integer" } },
      required: ["value"]
    });
    const positive = refineValidator(base, value =>
      value.value > 0
        ? null
        : { path: ["value"], code: "positive", message: "Value must be positive" }
    );
    let laterCalls = 0;
    const even = refineValidator(positive, value => {
      laterCalls += 1;
      return value.value % 2 === 0
        ? null
        : { path: ["value"], code: "even", message: "Value must be even" };
    });

    const result = even.validate({ value: 3 });
    expect(result).toEqual({
      valid: false,
      issues: [{ path: ["value"], code: "even", message: "Value must be even" }]
    });
    if (!result.valid) {
      expect(Object.isFrozen(result.issues)).toBe(true);
      expect(Object.isFrozen(result.issues[0])).toBe(true);
      expect(Object.isFrozen(result.issues[0].path)).toBe(true);
    }
    expect(even.is({ value: -2 })).toBe(false);
    expect(laterCalls).toBe(1);
    expect(even.assert({ value: 4 })).toEqual({ value: 4 });
  });

  it("propagates refinement exceptions as programmer errors", () => {
    const validator = refineValidator(
      createValidator({ kind: "string" }),
      () => {
        throw new Error("refinement failed");
      }
    );

    expect(() => validator.validate("value")).toThrow("refinement failed");
    expect(() => validator.is("value")).toThrow("refinement failed");
    expect(() => validator.assert("value")).toThrow("refinement failed");
  });

  it("rejects malformed refinement issues with precise errors", () => {
    const validator = refineValidator(
      createValidator({ kind: "string" }),
      () => ({ path: ["field", true], code: "bad", message: "bad" }) as never
    );

    expect(() => validator.validate("value")).toThrow(
      "Refinement issue.path must be an array of strings or numbers"
    );
  });

  it("handles required, nullable, optional, and additional object properties", () => {
    const validator = createValidator({
      kind: "object",
      properties: {
        name: { kind: "string", minLength: 2 },
        nickname: { kind: "string", optional: true },
        note: { kind: "string", nullable: true }
      },
      required: ["name", "note"],
      additionalProperties: false
    });

    expect(validator.is({ name: "Al", note: null })).toBe(true);
    expect(validator.is({ name: "A", note: null })).toBe(false);
    expect(validator.is({ name: "Al" })).toBe(false);
    const result = validator.validate({ name: "Al", note: null, extra: true });
    expect(result).toMatchObject({
      valid: false,
      issues: [{ path: ["extra"], code: "additionalProperties" }]
    });
    expect(validator.is({ name: "Al", note: null, nickname: undefined })).toBe(true);
  });

  it("validates nested arrays, tuples, and bounded array constraints", () => {
    const validator = createValidator({
      kind: "object",
      properties: {
        values: {
          kind: "array",
          items: { kind: "number", multipleOf: 0.5 },
          minItems: 1,
          maxItems: 3
        },
        pair: {
          kind: "tuple",
          items: [
            { kind: "string" },
            { kind: "integer" }
          ]
        }
      },
      required: ["values", "pair"]
    });

    expect(validator.is({ values: [1, 1.5], pair: ["ok", 2] })).toBe(true);
    const result = validator.validate({
      values: [1.1],
      pair: ["ok"]
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: ["values", 0], code: "multipleOf" }),
          expect.objectContaining({ path: ["pair", 1], code: "required" })
        ])
      );
    }
    expect(validator.is({ values: [1], pair: ["ok", 2, 3] })).toBe(false);
  });

  it("supports prefix items, unions, oneOf, intersections, literals, and enums", () => {
    const tuple = createValidator({
      kind: "array",
      prefixItems: [{ kind: "string" }, { kind: "integer" }],
      items: false
    });
    expect(tuple.is(["room", 1])).toBe(true);
    expect(tuple.is(["room", 1, true])).toBe(false);

    const union = createValidator({
      kind: "union",
      anyOf: [{ kind: "string" }, { kind: "integer" }]
    });
    expect(union.is("room")).toBe(true);
    expect(union.is(2)).toBe(true);
    expect(union.validate(false)).toMatchObject({
      valid: false,
      issues: [{ path: [], code: "union" }]
    });

    const oneOf = createValidator({
      kind: "oneOf",
      anyOf: [{ kind: "number" }, { kind: "integer" }]
    });
    expect(oneOf.is(1.5)).toBe(true);
    expect(oneOf.is(1)).toBe(false);

    const intersection = createValidator({
      kind: "intersection",
      allOf: [
        { kind: "number", minimum: 1 },
        { kind: "number", maximum: 3 }
      ]
    });
    expect(intersection.is(2)).toBe(true);
    expect(intersection.is(4)).toBe(false);

    expect(createValidator({ kind: "literal", value: "ready" }).is("ready")).toBe(true);
    expect(createValidator({ kind: "enum", values: ["draft", "ready"] }).is("ready")).toBe(true);
  });

  it("reports string constraints and common formats", () => {
    const validator = createValidator({
      kind: "string",
      minLength: 3,
      maxLength: 6,
      pattern: "^[A-Z]+$",
      format: "email"
    });
    expect(validator.is("ABC@example.com")).toBe(false);
    expect(validator.is("a@b.com")).toBe(false);
    expect(createValidator({ kind: "string", format: "email" }).is("user@example.com")).toBe(true);
    expect(createValidator({ kind: "string", format: "uuid" }).is("550e8400-e29b-41d4-a716-446655440000")).toBe(true);
    expect(createValidator({ kind: "string", format: "date" }).is("2024-02-29")).toBe(true);
    expect(createValidator({ kind: "string", format: "date" }).is("2023-02-29")).toBe(false);
    expect(createValidator({ kind: "string", format: "date-time" }).is("2024-02-29T12:30:00Z")).toBe(true);
    expect(createValidator({ kind: "string", format: "date-time" }).is("2024-02-29T12:30")).toBe(true);
    expect(createValidator({ kind: "string", format: "date-time" }).is("2024-02-29T12:30:00")).toBe(true);
    expect(createValidator({ kind: "string", format: "time" }).is("12:30")).toBe(true);
    expect(createValidator({ kind: "string", format: "time" }).is("12:30:00")).toBe(true);
    expect(createValidator({ kind: "string", format: "time" }).is("12:30:00+00:00")).toBe(true);
    expect(createValidator({ kind: "string", format: "time" }).is("24:00")).toBe(false);
    expect(createValidator({ kind: "string", format: "uri" }).is("https://example.com/rooms")).toBe(true);
    expect(createValidator({ kind: "string", format: "ipv4" }).is("192.168.1.1")).toBe(true);
    expect(createValidator({ kind: "string", format: "ipv6" }).is("2001:db8::1")).toBe(true);
  });

  it("accepts empty JSON Schema strings emitted by Pydantic", () => {
    const string = createValidator({ kind: "string", pattern: "" });
    expect(string.is("anything")).toBe(true);

    const object = createValidator({
      kind: "object",
      properties: { "": { kind: "string" } },
      required: [""],
      additionalProperties: false
    });
    expect(object.is({ "": "present" })).toBe(true);
  });

  it("resolves local and recursive references while rejecting cyclic values", () => {
    const tree: ValidationPlan = {
      kind: "ref",
      name: "TreeNode",
      definitions: {
        TreeNode: {
          kind: "object",
          properties: {
            name: { kind: "string" },
            children: {
              kind: "array",
              items: { kind: "ref", name: "TreeNode" }
            }
          },
          required: ["name", "children"]
        }
      }
    };
    const validator = createValidator(tree);
    expect(
      validator.is({
        name: "root",
        children: [{ name: "leaf", children: [] }]
      })
    ).toBe(true);

    const cyclic: { name: string; children: unknown[] } = {
      name: "root",
      children: []
    };
    cyclic.children.push(cyclic);
    expect(validator.validate(cyclic)).toMatchObject({
      valid: false,
      issues: [expect.objectContaining({ code: "cycle" })]
    });
  });

  it("bounds traversal and issue allocation", () => {
    const recursive: ValidationPlan = {
      kind: "ref",
      name: "Node",
      definitions: {
        Node: {
          kind: "object",
          properties: { child: { kind: "ref", name: "Node" } },
          required: ["child"]
        }
      }
    };
    const validator = createValidator(recursive, { maxDepth: 2, maxIssues: 2 });
    expect(
      validator.validate({ child: { child: { child: {} } } })
    ).toMatchObject({
      valid: false,
      issues: [expect.objectContaining({ code: "maxDepth" })]
    });

    const many = createValidator({
      kind: "object",
      properties: {
        a: { kind: "string" },
        b: { kind: "string" },
        c: { kind: "string" }
      },
      required: ["a", "b", "c"]
    }, { maxIssues: 2 });
    const result = many.validate({});
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.issues).toHaveLength(2);

    const bounded = createValidator(
      { kind: "array", items: { kind: "integer" } },
      { maxOperations: 4 }
    );
    const boundedResult = bounded.validate([1, 2, 3, 4]);
    expect(boundedResult.valid).toBe(false);
    expect(boundedResult.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "maxOperations" })])
    );
    expect(() => createValidator({ kind: "any" }, { maxOperations: 0 })).toThrow(
      /maxOperations must be a positive integer/
    );
  });

  it("rejects deeply nested validation plans before recursive traversal", () => {
    let plan: ValidationPlan = { kind: "any" };
    for (let depth = 0; depth < 20_000; depth += 1) {
      plan = { kind: "array", items: plan };
    }

    expect(() => createValidator(plan)).toThrow(
      /plan values exceed the maximum nesting depth/
    );
  });

  it("does not throw for hostile object, array, revoked, or enumeration proxies", () => {
    const objectValidator = createValidator({
      kind: "object",
      properties: { value: { kind: "string" } },
      required: ["value"]
    });
    const throwingDescriptor = new Proxy(
      {},
      {
        getOwnPropertyDescriptor() {
          throw new Error("descriptor trap");
        }
      }
    );
    expect(() => objectValidator.validate(throwingDescriptor)).not.toThrow();
    expect(objectValidator.validate(throwingDescriptor)).toMatchObject({
      valid: false,
      issues: expect.arrayContaining([expect.objectContaining({ code: "read" })])
    });

    const throwingKeys = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("keys trap");
        }
      }
    );
    const rejectingKeys = createValidator({
      kind: "object",
      additionalProperties: false
    });
    expect(() => rejectingKeys.validate(throwingKeys)).not.toThrow();
    expect(rejectingKeys.validate(throwingKeys)).toMatchObject({
      valid: false,
      issues: expect.arrayContaining([expect.objectContaining({ code: "read" })])
    });

    const unboundedKeys = new Proxy(
      { value: "ok" },
      {
        ownKeys() {
          throw new Error("keys trap");
        }
      }
    );
    expect(objectValidator.validate(unboundedKeys)).toMatchObject({ valid: true });

    const arrayValidator = createValidator({
      kind: "array",
      items: { kind: "string" }
    });
    const throwingIndex = new Proxy(["ok"], {
      get(target, property, receiver) {
        if (property === "0") throw new Error("index trap");
        return Reflect.get(target, property, receiver);
      }
    });
    expect(() => arrayValidator.validate(throwingIndex)).not.toThrow();
    expect(arrayValidator.validate(throwingIndex)).toMatchObject({
      valid: false,
      issues: [expect.objectContaining({ path: [0], code: "read" })]
    });

    const revoked = Proxy.revocable([], {});
    revoked.revoke();
    expect(() => arrayValidator.validate(revoked.proxy)).not.toThrow();
  });

  it("bounds huge sparse arrays and hostile length or prototype traps", () => {
    const validator = createValidator(
      { kind: "array", items: { kind: "string" } },
      { maxOperations: 8 }
    );
    const sparse: unknown[] = [];
    sparse.length = 1_000_000_000;
    expect(validator.validate(sparse)).toMatchObject({
      valid: false,
      issues: expect.arrayContaining([
        expect.objectContaining({ code: "maxOperations" })
      ])
    });

    const throwingLength = new Proxy([], {
      get(target, property, receiver) {
        if (property === "length") throw new Error("length trap");
        return Reflect.get(target, property, receiver);
      }
    });
    expect(() => validator.validate(throwingLength)).not.toThrow();
    expect(validator.validate(throwingLength)).toMatchObject({
      valid: false,
      issues: [expect.objectContaining({ code: "read" })]
    });

    const throwingPrototype = new Proxy({}, {
      getPrototypeOf() {
        throw new Error("prototype trap");
      }
    });
    const objectValidator = createValidator({ kind: "object" });
    expect(() => objectValidator.validate(throwingPrototype)).not.toThrow();
    expect(objectValidator.validate(throwingPrototype)).toMatchObject({
      valid: false,
      issues: [expect.objectContaining({ code: "type" })]
    });
  });

  it("applies the operation boundary before pattern or format work", () => {
    const maximumStringLength = DEFAULT_VALIDATION_MAX_OPERATIONS - 1;
    const atBudget = "a".repeat(maximumStringLength);
    const overBudget = `${atBudget}a`;
    const hostileNonMatch = `${"a".repeat(maximumStringLength - 1)}!`;
    const pattern = createValidator({ kind: "string", pattern: "^a+$" });
    const format = createValidator({ kind: "string", format: "email" });

    expect(pattern.is(atBudget)).toBe(true);
    expect(pattern.is(hostileNonMatch)).toBe(false);
    expect(pattern.validate(overBudget)).toMatchObject({
      valid: false,
      issues: [expect.objectContaining({ code: "maxOperations" })]
    });
    expect(format.validate(overBudget)).toMatchObject({
      valid: false,
      issues: [expect.objectContaining({ code: "maxOperations" })]
    });
  });

  it("accepts shared DAG values and null-prototype prototype-sensitive properties", () => {
    const childPlan: ValidationPlan = {
      kind: "object",
      properties: { value: { kind: "string" } },
      required: ["value"]
    };
    const validator = createValidator({
      kind: "object",
      properties: {
        left: childPlan,
        right: childPlan,
        dangerous: {
          kind: "object",
          properties: Object.fromEntries([
            ["__proto__", { kind: "string" }],
            ["constructor", { kind: "string" }],
            ["prototype", { kind: "string" }]
          ]),
          required: ["__proto__", "constructor", "prototype"]
        }
      },
      required: ["left", "right", "dangerous"]
    });
    const shared = { value: "safe" };
    const dangerous = Object.create(null) as Record<string, unknown>;
    dangerous.__proto__ = "safe";
    dangerous.constructor = "safe";
    dangerous.prototype = "safe";

    expect(validator.is({ left: shared, right: shared, dangerous })).toBe(true);
    expect(Object.prototype).not.toHaveProperty("polluted");
  });

  it("caps and freezes hundreds of independent issues", () => {
    const properties = Object.fromEntries(
      Array.from({ length: 250 }, (_, index) => [
        `field${index}`,
        { kind: "string" as const }
      ])
    );
    const validator = createValidator({
      kind: "object",
      properties,
      required: Object.keys(properties)
    });
    const result = validator.validate({});

    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.issues).toHaveLength(100);
    expect(Object.isFrozen(result.issues)).toBe(true);
    for (const issue of result.issues) {
      expect(Object.isFrozen(issue)).toBe(true);
      expect(Object.isFrozen(issue.path)).toBe(true);
    }
  });

  it("distinguishes deep values from cycles and reports the depth bound", () => {
    const recursive: ValidationPlan = {
      kind: "ref",
      name: "Node",
      definitions: {
        Node: {
          kind: "object",
          properties: { child: { kind: "ref", name: "Node" } },
          required: ["child"]
        }
      }
    };
    let value: Record<string, unknown> = {};
    for (let depth = 0; depth < 70; depth += 1) {
      value = { child: value };
    }
    const result = createValidator(recursive).validate(value);
    expect(result).toMatchObject({
      valid: false,
      issues: expect.arrayContaining([expect.objectContaining({ code: "maxDepth" })])
    });
    if (!result.valid) {
      expect(result.issues.some(issue => issue.code === "cycle")).toBe(false);
    }
  });

  it("uses exact multipleOf checks for safe integers and decimal boundaries", () => {
    const even = createValidator({ kind: "number", multipleOf: 2 });
    expect(even.is(Number.MAX_SAFE_INTEGER)).toBe(false);
    expect(even.is(Number.MAX_SAFE_INTEGER - 1)).toBe(true);

    const tenth = createValidator({ kind: "number", multipleOf: 0.1 });
    expect(tenth.is(0.3)).toBe(true);
    expect(tenth.is(0.30000000000000004)).toBe(true);
    expect(tenth.is(1.0000000000000002)).toBe(true);
    expect(tenth.is(0.31)).toBe(false);
  });

  it("rejects unsafe or non-portable patterns before runtime evaluation", () => {
    expect(() => createValidator({ kind: "string", pattern: "^(a){1,3}$" })).toThrow(
      /quantified groups/
    );
    expect(() => createValidator({ kind: "string", pattern: "^\\w+$" })).toThrow(
      /escape whose semantics are not portable/
    );
    expect(() => createValidator({ kind: "string", pattern: "(?P<word>a+)" })).toThrow(
      /named capture groups/
    );
    expect(() => createValidator({ kind: "string", pattern: "^a{1,3}b{1,3}$" })).toThrow(
      /multiple quantifiers/
    );
    expect(createValidator({ kind: "string", pattern: "^é+$" }).is("éé")).toBe(true);
  });

  it("enforces the shared adversarial pattern policy table", () => {
    for (const testCase of validationPatternCases.accepted) {
      const validator = createValidator({
        kind: "string",
        pattern: testCase.pattern
      });
      expect(validator.is(testCase.valid), testCase.pattern).toBe(true);
      expect(validator.is(testCase.invalid), testCase.pattern).toBe(false);
    }
    for (const pattern of validationPatternCases.rejected) {
      expect(
        () => createValidator({ kind: "string", pattern }),
        pattern
      ).toThrow();
    }
    expect(() => createValidator({
      kind: "string",
      pattern: "a".repeat(8_193)
    })).toThrow(/pattern is too long/);
  });

  it("accepts Pydantic date and time spellings while rejecting impossible years", () => {
    const date = createValidator({ kind: "string", format: "date" });
    const dateTime = createValidator({ kind: "string", format: "date-time" });
    const time = createValidator({ kind: "string", format: "time" });

    expect(date.is("0001-01-01")).toBe(true);
    expect(date.is("0000-01-01")).toBe(false);
    expect(date.is("10000-01-01")).toBe(false);
    expect(dateTime.is("2024-01-01T12:30:00z")).toBe(true);
    expect(time.is("12:30:00z")).toBe(true);
  });

  it("bounds literal and enum comparisons and object enumeration", () => {
    const literal = createValidator(
      {
        kind: "literal",
        value: Object.fromEntries(
          Array.from({ length: 20 }, (_, index) => [`key${index}`, index])
        )
      },
      { maxProperties: 4 }
    );
    const literalResult = literal.validate(
      Object.fromEntries(
        Array.from({ length: 20 }, (_, index) => [`key${index}`, index])
      )
    );
    expect(literalResult).toMatchObject({
      valid: false,
      issues: expect.arrayContaining([expect.objectContaining({ code: "maxProperties" })])
    });

    const object = createValidator(
      { kind: "object", additionalProperties: false },
      { maxProperties: 2 }
    );
    expect(object.validate({ a: 1, b: 2, c: 3 })).toMatchObject({
      valid: false,
      issues: [expect.objectContaining({ code: "maxProperties" })]
    });
  });

  it("bounds literal, enum, and metadata values before plan construction", () => {
    let nested: unknown = "leaf";
    for (let depth = 0; depth < 66; depth += 1) {
      nested = { value: nested };
    }

    expect(() => createValidator({ kind: "literal", value: nested })).toThrow(
      /plan values exceed the maximum nesting depth/
    );
    expect(() => createValidator({ kind: "enum", values: [nested] })).toThrow(
      /plan values exceed the maximum nesting depth/
    );
    expect(() => createValidator({ kind: "any", examples: [nested] })).toThrow(
      /plan values exceed the maximum nesting depth/
    );
  });

  it("enforces exact validation-plan child, string, cycle, and sharing boundaries", () => {
    expect(() => createValidator({
      kind: "any",
      examples: Array.from({ length: 10_000 }, () => null)
    })).not.toThrow();
    expect(() => createValidator({
      kind: "any",
      examples: Array.from({ length: 10_001 }, () => null)
    })).toThrow(/plan arrays contain more than 10000 entries/);

    expect(() => createValidator({
      kind: "any",
      description: "x".repeat(65_536)
    })).not.toThrow();
    expect(() => createValidator({
      kind: "any",
      description: "x".repeat(65_537)
    })).toThrow(/string exceeds the maximum length of 65536/);

    const circular: ValidationPlan = { kind: "array", items: { kind: "any" } };
    (circular as { items: ValidationPlan }).items = circular;
    expect(() => createValidator(circular)).toThrow(/plan values cannot be circular/);

    const shared: ValidationPlan = { kind: "string" };
    expect(() => createValidator({
      kind: "tuple",
      items: [shared, shared]
    })).not.toThrow();
  });

  it("enforces one aggregate budget across plan JSON values", () => {
    const examples = Array.from({ length: 1_000 }, () =>
      Array.from({ length: 100 }, (_, index) => index)
    );

    expect(() => createValidator({ kind: "any", examples })).toThrow(
      /plan contains more than 100000 JSON values/
    );
  });

  it("rejects malformed or unsupported plans instead of silently dropping rules", () => {
    expect(() => createValidator({ kind: "string", format: "hostname" })).toThrow(
      /Unsupported validation format/
    );
    expect(() => createValidator({ kind: "string", pattern: "[" })).toThrow(
      /regular expression/
    );
    expect(() =>
      createValidator({ kind: "number", multipleOf: 0 })
    ).toThrow(/multipleOf/);
    expect(() =>
      createValidator({ kind: "object", additionalProperties: { kind: "unknown" } } as never)
    ).toThrow(/Unsupported validation plan kind/);
    expect(createValidator({ kind: "ref", name: "Missing" }).validate({})).toMatchObject({
      valid: false,
      issues: [{ code: "ref" }]
    });
  });

  it.each([
    { path: [], formatted: "$" },
    { path: ["field"], formatted: "field" },
    { path: ["address", "city"], formatted: "address.city" },
    { path: ["rooms", 0], formatted: "rooms[0]" },
    { path: ["rooms", 0, "rate"], formatted: "rooms[0].rate" },
    {
      path: ["users", 0, "contacts", 1, "email"],
      formatted: "users[0].contacts[1].email"
    },
    { path: ["matrix", 0, 1], formatted: "matrix[0][1]" },
    { path: ["0"], formatted: '["0"]' },
    { path: [0], formatted: "[0]" },
    { path: ["$"], formatted: '["$"]' },
    { path: ["$", "value"], formatted: '["$"].value' },
    { path: ["field", "$"], formatted: "field.$" },
    { path: ["unsafe key"], formatted: '["unsafe key"]' },
    { path: ["a.b"], formatted: '["a.b"]' },
    { path: ["a[b]"], formatted: '["a[b]"]' },
    { path: ["constructor"], formatted: "constructor" },
    { path: ["__proto__"], formatted: "__proto__" }
  ])("formats $path as $formatted", ({ path, formatted }) => {
    expect(formatValidationPath(path)).toBe(formatted);
  });

  it("formats issues without changing their structured paths", () => {
    const issue = createValidationIssue(
      ["rooms", 0, "rate"],
      "minimum",
      "Must be greater than zero"
    );

    expect(formatValidationPath(issue.path)).toBe("rooms[0].rate");
    expect(issue.path).toEqual(["rooms", 0, "rate"]);
    expect(typeof issue.path[1]).toBe("number");
  });
});
