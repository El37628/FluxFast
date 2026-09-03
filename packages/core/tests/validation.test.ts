import { describe, expect, it } from "vitest";
import {
  ValidationError,
  createValidator,
  formatValidationPath,
  type ValidationPlan
} from "../src";

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
    expect(() => objectValidator.validate(throwingKeys)).not.toThrow();
    expect(objectValidator.validate(throwingKeys)).toMatchObject({
      valid: false,
      issues: expect.arrayContaining([expect.objectContaining({ code: "read" })])
    });

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

  it("uses exact multipleOf checks for safe integers and decimal boundaries", () => {
    const even = createValidator({ kind: "number", multipleOf: 2 });
    expect(even.is(Number.MAX_SAFE_INTEGER)).toBe(false);
    expect(even.is(Number.MAX_SAFE_INTEGER - 1)).toBe(true);

    const tenth = createValidator({ kind: "number", multipleOf: 0.1 });
    expect(tenth.is(0.3)).toBe(true);
    expect(tenth.is(0.30000000000000004)).toBe(false);
  });

  it("rejects unsafe or non-portable patterns before runtime evaluation", () => {
    expect(() => createValidator({ kind: "string", pattern: "^(a+)+$" })).toThrow(
      /quantified groups/
    );
    expect(() => createValidator({ kind: "string", pattern: "^\\w+$" })).toThrow(
      /escape whose semantics are not portable/
    );
    expect(createValidator({ kind: "string", pattern: "^é+$" }).is("éé")).toBe(true);
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

  it("formats nested paths for error displays", () => {
    expect(formatValidationPath([])).toBe("$");
    expect(formatValidationPath(["address", "city"])).toBe("address.city");
    expect(formatValidationPath(["rooms", 0, "rate"])).toBe("rooms.0.rate");
    expect(formatValidationPath(["unsafe key"])).toBe('["unsafe key"]');
  });
});
