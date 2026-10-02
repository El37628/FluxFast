// @vitest-environment happy-dom

import React, { act, useId } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Root } from "react-dom/client";
import { FluxRoot, useResource, type FluxApplicationProps } from "../src/index";
import { hydrateFluxApplication } from "../src/client";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const roots: Root[] = [];
const envelope = { protocol: "fluxfast/1" as const, page: { component: "home/index", url: "/?tag=one&tag=two" }, resources: { greeting: { value: "Same initial value", version: "opaque-v1" } } };
function Page() { return <h1 id={useId()}>{useResource<string>("greeting")}</h1>; }
function Application(props: FluxApplicationProps) { return <FluxRoot {...props} registry={{ "home/index": Page }} />; }
function documentWith(payload: unknown = { initialEnvelope: envelope }) {
  const markup = renderToString(<Application initialEnvelope={envelope} />, { identifierPrefix: "fluxfast-" });
  document.body.innerHTML = `<div id="fluxfast-root">${markup}</div><script id="fluxfast-page" type="application/json"></script>`;
  document.getElementById("fluxfast-page")!.textContent = JSON.stringify(payload);
}
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  document.body.replaceChildren();
});

describe("exact-envelope browser hydration", () => {
  it("hydrates real SSR markup without ID mismatch, refetching, or changing ready resource values", async () => {
    documentWith();
    const before = document.querySelector("h1")!.outerHTML;
    const fetch = vi.spyOn(globalThis, "fetch");
    const errors = vi.fn();
    await act(async () => { roots.push(hydrateFluxApplication(Application, { onRecoverableError: errors })); });
    expect(document.querySelector("h1")!.outerHTML).toBe(before);
    expect(errors).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(document.querySelector("h1")!.textContent).toBe("Same initial value");
  });

  it("never lets additional payload keys select a backend address or arbitrary props", async () => {
    documentWith({ initialEnvelope: envelope, clientUrl: "https://private.example:8123", backendUrl: "secret", arbitrary: true });
    const captured: FluxApplicationProps[] = [];
    function Capturing(props: FluxApplicationProps) { captured.push(props); return <Application {...props} />; }
    await act(async () => { roots.push(hydrateFluxApplication(Capturing)); });
    expect(captured[0]).toEqual({ initialEnvelope: envelope });
  });

  it.each([null, [], {}, { initialEnvelope: { protocol: "bad" } }, { initialEnvelope: envelope, cache: { maxResources: 0 } }, { initialEnvelope: envelope, cache: [] }, { initialEnvelope: envelope, development: {} }])("rejects malformed payload %# before mutating the SSR root", payload => {
    documentWith(payload);
    const before = document.getElementById("fluxfast-root")!.innerHTML;
    expect(() => hydrateFluxApplication(Application)).toThrow();
    expect(document.getElementById("fluxfast-root")!.innerHTML).toBe(before);
  });

  it.each(["missing-root", "missing-payload", "duplicate-root", "duplicate-payload", "wrong-type", "not-script"])("rejects a %s document", defect => {
    documentWith();
    const root = document.getElementById("fluxfast-root")!;
    const payload = document.getElementById("fluxfast-page")!;
    if (defect === "missing-root") root.remove();
    if (defect === "missing-payload") payload.remove();
    if (defect === "duplicate-root") document.body.append(root.cloneNode(true));
    if (defect === "duplicate-payload") document.body.append(payload.cloneNode(true));
    if (defect === "wrong-type") payload.setAttribute("type", "text/javascript");
    if (defect === "not-script") payload.outerHTML = '<div id="fluxfast-page" type="application/json">{}</div>';
    expect(() => hydrateFluxApplication(Application)).toThrow("document requires");
  });

  it("drops development metadata in a production hydration entry", async () => {
    vi.stubEnv("NODE_ENV", "production");
    documentWith({ initialEnvelope: envelope, development: { secret: "must-not-propagate" } });
    const captured: FluxApplicationProps[] = [];
    function Capturing(props: FluxApplicationProps) { captured.push(props); return <Application {...props} />; }
    await act(async () => { roots.push(hydrateFluxApplication(Capturing)); });
    expect(captured[0]).toEqual({ initialEnvelope: envelope });
  });

  it("retains valid cache settings and validated development metadata without transport configuration", async () => {
    const development = { initialPath: "/rooms", initialServerTrace: {
      protocol: "fluxfast-devtools/1", requestId: "ffdev_ssr", type: "page", durationMs: 3,
      pageMs: 1, resourcesMs: 1, serializeMs: 1, resources: [], truncated: false,
    } };
    documentWith({ initialEnvelope: envelope, cache: { maxResources: 100, maxPages: 20 }, development });
    const captured: FluxApplicationProps[] = [];
    function Capturing(props: FluxApplicationProps) { captured.push(props); return <Application {...props} />; }
    await act(async () => { roots.push(hydrateFluxApplication(Capturing)); });
    expect(captured[0]).toEqual({ initialEnvelope: envelope, cache: { maxResources: 100, maxPages: 20 }, development });
  });
});
