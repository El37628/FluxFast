import React from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import * as bindings from "@fluxfast/react";
import * as next from "../src/index";
import * as client from "../src/client";

describe("host-independent React compatibility", () => {
  it("re-exports the identical context, components, hooks, and resolver state", () => {
    for (const [name, value] of Object.entries(bindings)) {
      expect((next as Record<string, unknown>)[name], name).toBe(value);
      expect((client as Record<string, unknown>)[name], name).toBe(value);
    }
    expect(next.FluxContext).toBe(bindings.FluxContext);
    const registry = { "home/index": () => <h1>Shared page</h1> };
    next.setComponentRegistry(registry);
    expect(bindings.getComponentRegistry()).toBe(registry);
    expect(bindings.resolveComponent("home/index")).toBe(registry["home/index"]);
    bindings.setComponentRegistry({});
  });

  it("uses Next providers with React hooks and React providers with Next hooks", () => {
    const initialEnvelope = {
      protocol: "fluxfast/1" as const,
      page: { component: "home/index", url: "/?filter=open" },
      resources: { greeting: { value: "Hello", version: "v1" } },
    };
    function ReactConsumer() {
      return <p>{bindings.useResource<string>("greeting")}: {bindings.usePage().url}</p>;
    }
    function NextConsumer() {
      return <p>{next.useResource<string>("greeting")}: {next.usePage().url}</p>;
    }
    for (const [Provider, Consumer] of [[next.FluxProvider, ReactConsumer], [bindings.FluxProvider, NextConsumer]] as const) {
      const html = renderToString(<Provider initialEnvelope={initialEnvelope}><Consumer /></Provider>);
      expect(html).toContain("Hello");
      expect(html).toContain("/?filter=open");
    }
  });
});
