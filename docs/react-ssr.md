# React SSR and hydration boundary (unreleased v1.2)

This reference is for host authors. These APIs are **unreleased** and are not a
completed Vite adapter, an npm installation guide, or a new production service.
Next.js remains the implemented frontend host. The separate Vite asset/build
server, initialization, Python CLI selection, and full conformance run are still
required before v1.2.0 can ship.

React bindings live in `@fluxfast/react`. Host integrations have two separate
entry points, both supporting ESM, CommonJS, and TypeScript:

| Entry | Runtime | Responsibility |
| --- | --- | --- |
| `@fluxfast/react/server` | Node.js 22 or 24 | Complete React SSR and construct safe document/proxy responses through Web Request/Response. |
| `@fluxfast/react/client` | Browser | Hydrate existing SSR markup from the embedded initial envelope. |

Neither entry is re-exported through the bindings root. Importing browser
bindings or hydration does not import Node streams, Core/server, or Codegen.
The server entry depends on Core's existing initial-fetch, safe-header, and
streaming-proxy primitives; it does not duplicate their protocol logic.

## 1. An allowlisted application

```tsx
import { FluxRoot, useResource, type FluxApplicationProps } from "@fluxfast/react";

function Rooms() {
  const rooms = useResource<Array<{ id: number; name: string }>>("rooms");
  return <ul>{rooms.map(room => <li key={room.id}>{room.name}</li>)}</ul>;
}

export function Application(props: FluxApplicationProps) {
  return <FluxRoot {...props} registry={{ "rooms/index": Rooms }} />;
}
```

FastAPI chooses the component identifier and supplies the resources. This
registry is an allowlist, not a second application route table. Lazy entries
such as `{ load: () => import("./flux-pages/rooms") }` are supported. Unknown,
inherited, failed, or throwing entries fail rendering rather than loading an
arbitrary path or returning a successful empty page.

## 2. Render meaningful HTML

```tsx
import { renderFluxApplication } from "@fluxfast/react/server";
import { Application } from "./Application";

const html = await renderFluxApplication(Application, {
  initialEnvelope: {
    protocol: "fluxfast/1",
    page: { component: "rooms/index", url: "/rooms?available=1" },
    resources: {
      rooms: { version: "opaque-v1", value: [{ id: 1, name: "Meeting room" }] },
    },
  },
}, { timeoutMs: 30_000 });
// html includes: <ul><li>Meeting room</li></ul>
```

The result is a markup string, not a complete HTML document or a socket server.
Rendering uses React's `renderToPipeableStream` and waits for `onAllReady`, so a
lazy blocking page is included in the first document. It does not fall back to
client rendering of the entire page. Deferred resource fallbacks remain valid;
SSR does not start deferred fetches, history listeners, or live subscriptions.
[React's server rendering reference](https://react.dev/reference/react-dom/server/renderToPipeableStream)
describes this completion boundary.

`timeoutMs` defaults to 30,000 and must be an integer from 1 to 2,147,483,647.
`signal` optionally cancels rendering. A timeout, abort, import failure, or render
failure rejects the promise and releases the rendering timer/listener/stream.
A host must handle that failure before sending a successful document response.

## 3. Construct document and transport responses

```tsx
import { createFluxReactHandler, renderFluxApplication } from "@fluxfast/react/server";
import { Application } from "./Application";

const backendUrl = process.env.FLUXFAST_BACKEND_URL;
if (!backendUrl) throw new Error("Missing private backend configuration");

export const handle = createFluxReactHandler({
  backendUrl,
  template: `<!doctype html>
<html><head><meta charset="utf-8"><title>My application</title></head>
<body><div id="fluxfast-root"><!--fluxfast:ssr--></div>
<!--fluxfast:payload--><script type="module" src="/client.js"></script></body></html>`,
  render: (props, options) => renderFluxApplication(Application, props, options),
  forwardHeaders: ["x-csrf-token"],
  cache: { maxResources: 100, maxPages: 20 },
  timeoutMs: 30_000,
});

const response = await handle(new Request("https://app.example/rooms?available=1"));
// response.status === 200, content-type: text/html, cache-control: no-store
// await response.text() contains the rendered list AND its initial envelope.
```

The host owns the trusted template and asset URLs. Include exactly one
`<!--fluxfast:ssr-->` marker **inside** the single `id="fluxfast-root"` element,
and exactly one `<!--fluxfast:payload-->` marker outside that element. Neither
marker may be duplicated or omitted. A template callback can asynchronously
return transformed HTML for a request; never interpolate an unescaped incoming
URL or header into that trusted HTML.

The response embeds a non-executable `application/json` script with
`id="fluxfast-page"`. HTML delimiters and Unicode line separators are escaped,
including user resource values containing `</script>`. JSON decoding restores
their original values. Do not replace this with unescaped inline executable
JavaScript. Marker-like text in rendered application data is not processed as
another template marker.

For a normal document GET/HEAD, the handler preserves the encoded path and
query and selects safe cookie, authorization, language and user-agent headers,
plus explicit `forwardHeaders`. It uses a configured private backend URL, not
the incoming hostname. Canonical redirects remain restricted to that private
origin. A valid backend 404 returns a real HTTP 404 document; 401/403 remain access-denied
documents. Malformed successful/non-Flux responses and rendering errors fail with a generic
500. Abort/deadline failures return 503. Public failures contain no backend
address, native exception, upstream debug payload, or hydration envelope.
Non-Flux methods other than GET/HEAD return 405.

For an exact `X-FluxFast: 1`, the handler delegates the same-origin pathname,
query, method, headers and body to Core's streaming proxy. JSON mutations retain
their response status and separate Set-Cookie fields. SSE is not buffered or
subject to the document render timeout; incoming cancellation propagates to
the upstream fetch. The surrounding HTTP host must map client disconnect to
`Request.signal` and stream the returned body rather than calling `.text()`.

`development: true` explicitly enables safe SSR diagnostics; production
`NODE_ENV` suppresses them regardless of that flag. Non-development proxy
requests strip diagnostic opt-in and trace headers. No backend address or
credentials are added to application props. An optional `fetch` implementation
is server-only, chiefly useful for testing or a host integration.

This handler does **not** serve assets, bind a public port, supply health routes,
choose a package manager, initialize a project, or supervise FastAPI. Those
remain the host/Python adapter's responsibility. The standard complete host
must preserve one public origin with a private loopback FastAPI listener.

## 4. Hydrate the exact initial state

```tsx
// Browser entry; /client.js above must point to its real built/transformed URL.
import { hydrateFluxApplication } from "@fluxfast/react/client";
import { Application } from "./Application";

const root = hydrateFluxApplication(Application, {
  onRecoverableError: error => console.error("Hydration failed", error),
});
// Later, when permanently disposing this host's React tree: root.unmount();
```

This uses `hydrateRoot`, not `createRoot`. The first client render receives the
same component, resource values, opaque versions, URL/query, manifests,
deferred/live keys and resource errors as SSR. Blocking values are not fetched
again. The identifier prefix used for React `useId` matches server rendering.
[React's hydration reference](https://react.dev/reference/react-dom/client/hydrateRoot)
explains why this initial markup/state match matters.

The function requires one SSR root and one JSON payload. It rejects missing,
duplicate or wrong-type payload elements, malformed envelopes, invalid cache
limits and invalid development metadata before invoking hydration. Extra
payload keys are not spread into application props: they cannot choose a
private backend URL or an arbitrary component. The same-origin browser Core
transport needs no backend port. Production drops development metadata.

After hydration, the existing provider starts history, deferred and live work
and owns their effect cleanup. Call hydration once for a document; keep the
application/initial props stable. `document` optionally supplies a DOM document
for testing or integration. The return value is React DOM's `Root`.

## Complete integration API inventory

These additive host APIs are Advanced Stable when v1.2 ships. They do not
change the published Next binding imports or `fluxfast/1` wire contract.

<!-- react-ssr-api-examples:start -->
| Entry / export | Declaration or use |
| --- | --- |
| server / `renderFluxApplication` | `const markup = await renderFluxApplication(Application, { initialEnvelope: envelope });` |
| server / `createFluxReactHandler` | `const handle = createFluxReactHandler({ backendUrl, template, render });` |
| server / `RenderFluxApplicationOptions` | `const options: RenderFluxApplicationOptions = { signal: controller.signal, timeoutMs: 30_000 };` |
| server / `FluxReactRender` | `const render: FluxReactRender = (props, options) => renderFluxApplication(Application, props, options);` |
| server / `FluxReactHandlerOptions` | `const options: FluxReactHandlerOptions = { backendUrl, template, render, forwardHeaders: ["x-csrf-token"] };` |
| client / `hydrateFluxApplication` | `const root = hydrateFluxApplication(Application);` |
| client / `HydrateFluxApplicationOptions` | `const options: HydrateFluxApplicationOptions = { document, onRecoverableError: error => console.error(error) };` |
<!-- react-ssr-api-examples:end -->

See the [adapter contract](adapter-contract.md), [React bindings](react-api.md),
[generated artifacts](generated-artifacts.md), and [protocol](protocol.md).
