// @vitest-environment happy-dom

import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { FluxProvider, useResource } from "../src/index";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it("hydrates the bindings in a browser without a Node process global", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  function Page() {
    return <h1>{useResource<string>("greeting")}</h1>;
  }
  vi.stubGlobal("process", undefined);
  try {
    // Restore the global before yielding: Vitest's own asynchronous RPC uses
    // Node process.nextTick even though the browser bindings must not need it.
    act(() => root.render(
      <FluxProvider initialEnvelope={{
        protocol: "fluxfast/1",
        page: { component: "home/index", url: "/" },
        resources: { greeting: { value: "Browser ready", version: "v1" } },
      }}><Page /></FluxProvider>
    ));
    expect(container.querySelector("h1")?.textContent).toBe("Browser ready");
  } finally {
    vi.unstubAllGlobals();
    await act(async () => root.unmount());
    container.remove();
  }
});
