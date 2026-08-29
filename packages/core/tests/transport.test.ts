import { describe, expect, it, vi, afterEach } from "vitest";
import {
  assertPageEnvelope,
  assertMutationEnvelope,
  encodeKnownVersions,
  FetchTransport,
} from "../src/transport";
import { MutationError, ProtocolError, ValidationError } from "../src/errors";

afterEach(() => vi.unstubAllGlobals());

describe("FetchTransport", () => {
  it("encodes unicode known-resource metadata as base64url", () => {
    const encoded = encodeKnownVersions({ "hôtel": "版本-1" });
    expect(encoded).toBeDefined();
    const decoded = Buffer.from(encoded!, "base64url").toString("utf8");
    expect(JSON.parse(decoded)).toEqual({ "hôtel": "版本-1" });
  });

  it("omits known metadata that exceeds the decoded safety limit", () => {
    const known = Object.fromEntries(
      Array.from({ length: 100 }, (_, index) => [
        `resource-${index}-${"x".repeat(100)}`,
        "v".repeat(128),
      ])
    );
    expect(encodeKnownVersions(known)).toBeUndefined();
  });

  it("rejects malformed page envelopes", () => {
    expect(() => assertPageEnvelope({ protocol: "fluxfast/1", resources: {} }))
      .toThrowError(ProtocolError);
  });

  it("rejects unknown mutation patch operations", () => {
    expect(() => assertMutationEnvelope({
      protocol: "fluxfast/1",
      mutation: { patches: { rooms: [{ op: "execute-code" }] } },
    })).toThrowError(MutationError);
    expect(() => assertMutationEnvelope({
      protocol: "fluxfast/1",
      mutation: { patches: { rooms: [{ op: "remove-item" }] } },
    })).toThrowError(/requires|Incomplete/);
  });

  it("maps standard FastAPI validation details", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        detail: [{ loc: ["body", "email"], msg: "invalid email", type: "value_error" }],
      }), {
        status: 422,
        headers: { "content-type": "application/json" },
      })
    ));

    await expect(new FetchTransport().mutate({ url: "/users", data: {} }))
      .rejects.toMatchObject<Partial<ValidationError>>({
        name: "ValidationError",
        details: { email: ["invalid email"] },
      });
  });
});
