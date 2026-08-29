import { describe, expect, it } from "vitest";
import { buildFluxPath } from "../src/server";
import { resolveInternalDestination } from "../src/link";

describe("Next adapter paths", () => {
  it("reconstructs catch-all paths and repeated search parameters", () => {
    expect(buildFluxPath(["rooms", "101"], {
      status: "available",
      tag: ["sea view", "suite"],
    })).toBe("/rooms/101?status=available&tag=sea+view&tag=suite");
  });

  it("handles the optional catch-all root", () => {
    expect(buildFluxPath(undefined)).toBe("/");
  });

  it("only normalizes same-origin application links", () => {
    const current = "https://app.example/dashboard";
    expect(resolveInternalDestination("/rooms?page=2", current)).toBe("/rooms?page=2");
    expect(resolveInternalDestination("rooms", current)).toBe("/rooms");
    expect(resolveInternalDestination("https://elsewhere.example/rooms", current)).toBeNull();
    expect(resolveInternalDestination("mailto:team@example.com", current)).toBeNull();
  });
});
