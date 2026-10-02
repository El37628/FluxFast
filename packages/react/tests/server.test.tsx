import React, { useId } from "react";
import { describe, expect, it, vi } from "vitest";
import type { PageEnvelope } from "@fluxfast/core";
import { FluxRoot, useDeferredResource, useLiveStatus, useResource, type FluxApplicationProps } from "../src/index";
import { createFluxReactHandler, renderFluxApplication } from "../src/server/index";

const envelope: PageEnvelope = {
  protocol: "fluxfast/1", page: { component: "home/index", url: "/rooms?tag=one&tag=two" },
  resourceKeys: ["greeting", "later"], deferred: ["later"], live: ["greeting"],
  resources: { greeting: { value: "Actual SSR", version: "opaque-v1" } },
};
const template = '<!doctype html><html><body><div id="fluxfast-root"><!--fluxfast:ssr--></div><!--fluxfast:payload--><script type="module" src="/client.js"></script></body></html>';
function Page() {
  const greeting = useResource<string>("greeting");
  return <article id={useId()}><h1>{greeting}</h1><p>{useDeferredResource("later").status}</p><p>{useLiveStatus().status}</p></article>;
}
function Application(props: FluxApplicationProps) {
  return <FluxRoot {...props} registry={{ "home/index": { load: async () => ({ default: Page }) } }} />;
}
const render = (props: FluxApplicationProps, options = {}) => renderFluxApplication(Application, props, options);
function backend(body: unknown = envelope, status = 200) {
  return vi.fn<typeof fetch>(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
}
function payload(html: string): FluxApplicationProps {
  return JSON.parse(html.split('<script id="fluxfast-page" type="application/json">')[1].split("</script>")[0]);
}

describe("React SSR rendering", () => {
  it("waits for a lazy allowlisted page and renders blocking values without deferred/live work", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    try {
      const html = await render({ initialEnvelope: envelope });
      expect(html).toContain("<h1>Actual SSR</h1>");
      expect(html).toContain("<p>pending</p>");
      expect(html).toContain("<p>idle</p>");
      expect(html).toContain("fluxfast-");
      expect(html).not.toContain("data-msg");
      expect(fetch).not.toHaveBeenCalled();
    } finally { fetch.mockRestore(); }
  });

  it("fails a missing registry entry instead of returning a successful empty fallback", async () => {
    await expect(render({ initialEnvelope: { ...envelope, page: { component: "unknown", url: "/" } } })).rejects.toThrow("not found");
  });

  it("rejects a failed lazy page and a throwing component", async () => {
    function Invalid(props: FluxApplicationProps) {
      return <FluxRoot {...props} registry={{ "home/index": { load: async () => { throw new Error("import failed"); } } }} />;
    }
    await expect(renderFluxApplication(Invalid, { initialEnvelope: envelope })).rejects.toThrow("import failed");
    await expect(renderFluxApplication(() => { throw new Error("render failed"); }, { initialEnvelope: envelope })).rejects.toThrow("render failed");
  });

  it("bounds a lazy module that never resolves", async () => {
    function Stalled(props: FluxApplicationProps) {
      return <FluxRoot {...props} registry={{ "home/index": { load: () => new Promise(() => {}) } }} />;
    }
    await expect(renderFluxApplication(Stalled, { initialEnvelope: envelope }, { timeoutMs: 10 })).rejects.toThrow("timed out");
  });

  it("honors abort before rendering and during lazy loading", async () => {
    const already = AbortSignal.abort();
    await expect(renderFluxApplication(Application, { initialEnvelope: envelope }, { signal: already })).rejects.toThrow("aborted");
    const controller = new AbortController();
    function Stalled(props: FluxApplicationProps) {
      return <FluxRoot {...props} registry={{ "home/index": { load: () => new Promise(() => {}) } }} />;
    }
    const pending = renderFluxApplication(Stalled, { initialEnvelope: envelope }, { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow("aborted");
  });

  it.each([0, -1, Infinity, NaN, 1.5, 2_147_483_648])("rejects invalid timeout %s", timeoutMs => {
    expect(() => renderFluxApplication(Application, { initialEnvelope: envelope }, { timeoutMs })).toThrow("timeoutMs");
  });

  it.each([null, {}, { aborted: false }])("rejects invalid JavaScript signals before scheduling a render", signal => {
    expect(() => renderFluxApplication(Application, { initialEnvelope: envelope }, { signal: signal as unknown as AbortSignal })).toThrow("AbortSignal");
  });
});

describe("React document and same-origin boundary", () => {
  it("preserves repeated/encoded query values and safe cookie/auth headers", async () => {
    const fetch = backend();
    const handler = createFluxReactHandler({ backendUrl: "http://127.0.0.1:8123", template, render, fetch, forwardHeaders: ["x-csrf-token", "x-secret"] });
    const response = await handler(new Request("https://public.example/rooms?tag=one&tag=two&q=a%20b", { headers: {
      cookie: "session=user", authorization: "Bearer example", "x-csrf-token": "csrf",
      connection: "x-secret", "x-secret": "never-forward", host: "attacker.example",
    } }));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("cache-control")).toBe("no-store");
    const html = await response.text();
    expect(html).toContain("<h1>Actual SSR</h1>");
    expect(payload(html).initialEnvelope).toEqual(envelope);
    expect(html).not.toContain("127.0.0.1:8123");
    expect(fetch.mock.calls[0][0]).toBe("http://127.0.0.1:8123/rooms?tag=one&tag=two&q=a%20b");
    const init = fetch.mock.calls[0][1]!;
    const headers = new Headers(init.headers);
    expect(headers.get("cookie")).toBe("session=user");
    expect(headers.get("authorization")).toBe("Bearer example");
    expect(headers.get("x-csrf-token")).toBe("csrf");
    expect(headers.has("x-secret")).toBe(false);
    expect(headers.has("host")).toBe(false);
    expect(init.redirect).toBe("manual");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("isolates overlapping SSR resource stores for different authenticated requests", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      const user = new Headers(init?.headers).get("cookie")!;
      await new Promise(resolve => setTimeout(resolve, 2));
      return new Response(JSON.stringify({ ...envelope, resources: { greeting: { value: user, version: user } } }));
    });
    const handler = createFluxReactHandler({ backendUrl: "http://private.example", template, render, fetch });
    const results = await Promise.all(Array.from({ length: 12 }, async (_, user) => {
      const response = await handler(new Request("https://public.example/", { headers: { cookie: `user=${user};` } }));
      const html = await response.text();
      expect(response.status).toBe(200);
      expect(html).toContain(`<h1>user=${user};</h1>`);
      expect(payload(html).initialEnvelope.resources.greeting).toEqual({ value: `user=${user};`, version: `user=${user};` });
      return html;
    }));
    expect(new Set(results).size).toBe(12);
  });

  it("fails an already aborted document request before contacting the backend", async () => {
    const fetch = backend();
    const handler = createFluxReactHandler({ backendUrl: "http://private.example", template, render, fetch });
    const response = await handler(new Request("https://public.example/", { signal: AbortSignal.abort() }));
    expect(response.status).toBe(503);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("escapes script termination, HTML delimiters and Unicode without altering hydrated resource data", async () => {
    const value = '</script><script>window.exploited=1</script>&<>\u2028\u2029';
    const initial = { ...envelope, resources: { greeting: { value, version: "v1" } } };
    const handler = createFluxReactHandler({ backendUrl: "http://private.example", template, render, fetch: backend(initial) });
    const html = await (await handler(new Request("https://public.example/"))).text();
    const json = html.split('<script id="fluxfast-page" type="application/json">')[1].split("</script>")[0];
    expect(json).not.toMatch(/[<>&\u2028\u2029]/);
    expect(payload(html).initialEnvelope.resources.greeting.value).toBe(value);
    expect(html).not.toContain("<script>window.exploited");
  });

  it("does not treat markers inside rendered page data as template placeholders", async () => {
    const markup = '<p><!--fluxfast:payload--><!--fluxfast:ssr--></p>';
    const handler = createFluxReactHandler({ backendUrl: "http://private.example", template, render: async () => markup, fetch: backend() });
    const html = await (await handler(new Request("https://public.example/"))).text();
    expect(html).toContain(markup);
    expect(html.match(/id="fluxfast-page"/g)).toHaveLength(1);
  });

  it.each([404, 401, 403])("preserves actual HTTP %s without serializing backend errors", async status => {
    const render = vi.fn(async () => "should not render");
    const handler = createFluxReactHandler({ backendUrl: "http://private.example", template, render, fetch: backend({ detail: "private credential details" }, status) });
    const response = await handler(new Request("https://public.example/missing"));
    expect(response.status).toBe(status);
    const html = await response.text();
    expect(html).toContain("<!doctype html>");
    expect(html).not.toContain("private credential");
    expect(html).not.toContain("fluxfast-page");
    expect(render).not.toHaveBeenCalled();
  });

  it("follows only private-origin canonical redirects", async () => {
    const fetch = backend();
    fetch.mockResolvedValueOnce(new Response(null, { status: 307, headers: { location: "/rooms?tag=one&tag=two" } }));
    const handler = createFluxReactHandler({ backendUrl: "http://private.example", template, render, fetch });
    expect((await handler(new Request("https://public.example/canonical"))).status).toBe(200);
    expect(fetch.mock.calls.map(call => call[0])).toEqual(["http://private.example/canonical", "http://private.example/rooms?tag=one&tag=two"]);
    fetch.mockClear();
    fetch.mockResolvedValueOnce(new Response(null, { status: 307, headers: { location: "https://attacker.example" } }));
    expect((await handler(new Request("https://public.example/external"))).status).toBe(500);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("cannot enable production SSR diagnostics even with an explicit development opt-in", async () => {
    vi.stubEnv("NODE_ENV", "production");
    try {
      const fetch = backend();
      const handler = createFluxReactHandler({ backendUrl: "http://private.example", template, render, fetch, development: true });
      const response = await handler(new Request("https://public.example/", { headers: { "x-fluxfast-devtools": "1" } }));
      expect(response.status).toBe(200);
      expect(new Headers(fetch.mock.calls[0][1]?.headers).has("x-fluxfast-devtools")).toBe(false);
      expect(payload(await response.text()).development).toBeUndefined();
    } finally { vi.unstubAllEnvs(); }
  });

  it("passes only a validated development trace separately from the envelope", async () => {
    const trace = { protocol: "fluxfast-devtools/1", requestId: "ffdev_ssr", type: "page",
      durationMs: 3, pageMs: 1, resourcesMs: 1, serializeMs: 1, resources: [], truncated: false };
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify(envelope), {
      headers: { "x-fluxfast-devtools-trace": Buffer.from(JSON.stringify(trace)).toString("base64url") },
    }));
    const handler = createFluxReactHandler({ backendUrl: "http://private.example", template, render, fetch, development: true });
    const response = await handler(new Request("https://public.example/rooms?private-query=not-in-trace"));
    expect(response.status).toBe(200);
    const props = payload(await response.text());
    expect(props.initialEnvelope).toEqual(envelope);
    expect(props.development).toEqual({ initialPath: "/rooms", initialServerTrace: trace });
    expect(new Headers(fetch.mock.calls[0][1]?.headers).get("x-fluxfast-devtools")).toBe("1");
  });

  it.each(["not a url", "file:///tmp/backend", "https://user:secret@private.example", "http://private.example?override=1", "http://private.example#fragment"])("rejects invalid trusted backend configuration without reflecting it", backendUrl => {
    expect(() => createFluxReactHandler({ backendUrl, template, render })).toThrow("FluxFast backendUrl");
  });

  it.each(["not json", '{"openapi":"3.1.0"}', "<html>private debug</html>"])("rejects non-Flux or malformed backend response %s", async body => {
    const handler = createFluxReactHandler({ backendUrl: "http://private.example", template, render, fetch: async () => new Response(body) });
    const response = await handler(new Request("https://public.example/docs"));
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain(body);
  });

  it.each([template.replace("<!--fluxfast:ssr-->", ""), template + "<!--fluxfast:payload-->"])("fails closed on an invalid host template", async template => {
    const handler = createFluxReactHandler({ backendUrl: "http://private.example", template, render, fetch: backend() });
    expect((await handler(new Request("https://public.example/"))).status).toBe(500);
  });

  it.each(["fetch", "template", "render"])("bounds a stalled %s implementation", async stage => {
    const never = () => new Promise<never>(() => {});
    const handler = createFluxReactHandler({ backendUrl: "http://private.example", timeoutMs: 10,
      fetch: stage === "fetch" ? never : backend(), template: stage === "template" ? never : template,
      render: stage === "render" ? never : render });
    expect((await handler(new Request("https://public.example/"))).status).toBe(503);
  });

  it("supports HEAD and rejects non-Flux POST without reaching the backend", async () => {
    const fetch = backend();
    const handler = createFluxReactHandler({ backendUrl: "http://private.example", template, render, fetch });
    const head = await handler(new Request("https://public.example/", { method: "HEAD" }));
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    fetch.mockClear();
    const post = await handler(new Request("https://public.example/", { method: "POST", body: "plain" }));
    expect(post.status).toBe(405);
    expect(post.headers.get("allow")).toBe("GET, HEAD");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("proxies Flux mutations unchanged, retaining separate cookies and exact query", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response('{"ok":true}', { status: 422, headers: [
      ["set-cookie", "one=1; Path=/"], ["set-cookie", "two=2; Path=/"], ["content-type", "application/json"],
    ] }));
    const handler = createFluxReactHandler({ backendUrl: "http://private.example", template, render, fetch });
    const response = await handler(new Request("https://public.example/register?x=one&x=two", {
      method: "POST", body: '{"name":"Ada"}', headers: { "x-fluxfast": "1", "content-type": "application/json", cookie: "session=one" },
    }));
    expect(response.status).toBe(422);
    expect(response.headers.getSetCookie()).toEqual(["one=1; Path=/", "two=2; Path=/"]);
    expect(await response.text()).toBe('{"ok":true}');
    expect(fetch.mock.calls[0][0]).toBe("http://private.example/register?x=one&x=two");
    expect(new TextDecoder().decode(fetch.mock.calls[0][1]?.body as ArrayBuffer)).toBe('{"name":"Ada"}');
    expect(new Headers(fetch.mock.calls[0][1]?.headers).get("cookie")).toBe("session=one");
  });

  it("retains streaming SSE, request cancellation and production diagnostic exclusion", async () => {
    const cancel = vi.fn();
    const upstream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode("data: first\n\n")); }, cancel });
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(upstream, { headers: {
      "content-type": "text/event-stream", "x-fluxfast-devtools-trace": "must-not-expose",
    } }));
    const handler = createFluxReactHandler({ backendUrl: "http://private.example", template, render, fetch, timeoutMs: 10 });
    const controller = new AbortController();
    const request = new Request("https://public.example/rooms", { signal: controller.signal, headers: { "x-fluxfast": "1", "x-fluxfast-devtools": "1" } });
    const response = await handler(request);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(response.headers.has("x-fluxfast-devtools-trace")).toBe(false);
    expect(new Headers(fetch.mock.calls[0][1]?.headers).has("x-fluxfast-devtools")).toBe(false);
    // A cloned Request owns a following signal, not necessarily the same object.
    expect(fetch.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("data: first\n\n");
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(request.signal.aborted).toBe(false);
    controller.abort();
    expect(fetch.mock.calls[0][1]?.signal?.aborted).toBe(true);
    await reader.cancel();
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});
