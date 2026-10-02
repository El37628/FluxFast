import { describe, it, expect } from "vitest";
import React from "react";
import { setComponentRegistry, resolveComponent } from "../src/resolver";
import { ComponentResolutionError } from "@fluxfast/core";

describe("React Component Registry", () => {
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

  it.each(["constructor", "toString", "__proto__"])(
    "does not resolve inherited registry property %s as an allowlisted component",
    identifier => {
      expect(() => resolveComponent(identifier, {})).toThrow(ComponentResolutionError);
    }
  );

  it("requires an own entry even when an application gives the registry a prototype", () => {
    const Page = () => null;
    const registry = Object.create({ "inherited/page": Page });
    registry["own/page"] = Page;
    expect(resolveComponent("own/page", registry)).toBe(Page);
    expect(() => resolveComponent("inherited/page", registry)).toThrow(ComponentResolutionError);
  });
});
