import { describe, expect, it } from "vitest";
import { assertClientId, createClientId } from "../src/live/client-id";

describe("FluxFast client identity", () => {
  it("creates bounded opaque identities", () => {
    const first = createClientId();
    const second = createClientId();

    expect(first).toMatch(/^ff_[0-9a-f]{32}$/);
    expect(first.length).toBeLessThanOrEqual(64);
    expect(second).not.toBe(first);
    expect(() => assertClientId(first)).not.toThrow();
  });

  it.each([
    "",
    "contains space",
    "contains\nnewline",
    "x".repeat(65),
  ])("rejects unsafe identity %j", clientId => {
    expect(() => assertClientId(clientId)).toThrowError(/client ID/);
  });
});
