import { describe, it, expect } from "vitest";
import React from "react";
import { setComponentRegistry, resolveComponent } from "../src/resolver";
import { ComponentResolutionError } from "@fluxfast/core";

describe("Next Adapter Component Registry", () => {
  it("resolves registered components", () => {
    const DummyComponent = () => React.createElement("div", null, "Hello");
    setComponentRegistry({
      "dashboard/index": DummyComponent,
    });

    const Resolved = resolveComponent("dashboard/index");
    expect(Resolved).toBe(DummyComponent);
  });

  it("throws descriptive ComponentResolutionError on missing component (Section 60)", () => {
    setComponentRegistry({
      "dashboard/index": () => null,
      "rooms/index": () => null,
    });

    expect(() => resolveComponent("unknown/page")).toThrowError(ComponentResolutionError);
    expect(() => resolveComponent("unknown/page")).toThrowError(/dashboard\/index/);
  });

  it("creates one stable React.lazy wrapper for a generated loader", () => {
    const entry = { load: async () => ({ default: () => null }) };
    setComponentRegistry({ "lazy/index": entry });
    expect(resolveComponent("lazy/index")).toBe(resolveComponent("lazy/index"));
  });
});
