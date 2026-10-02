# React SSR with Vite (unreleased v1.2)

`@fluxfast/vite` is source-development tooling, not a published v1.1 package.
This host implements development compilation/HMR, production client/SSR builds,
and one public Node HTTP origin. Automatic initialization, Python React adapter
selection, full shared browser conformance and registry publication remain
separate work; this guide does not announce a completed v1.2 release.

## What each layer does

FastAPI selects application URLs, resources and component identifiers. The shared
Core runtime owns navigation, resource reconciliation and live/deferred behavior.
React bindings subscribe/render; their [SSR boundary](react-ssr.md) safely fetches,
renders and hydrates the same envelope. Vite compiles that application for Node
and the browser, while this host owns HTTP sockets, assets and lifecycle cleanup.
There is no React Router, duplicate page cache, or second application route table.

The browser uses only the host origin for documents, navigation, mutations,
deferred requests and SSE. A server-only backend URL is required; it is not a
`VITE_*` setting and must not appear in client code. Two internal processes do
not imply two public browser ports.

## Source-development setup

Use source-built Core, React and Vite package tarballs together, plus React,
React DOM 19+ and Vite `>=7.3.6 <8`. Node must be 22.12+ or 24. Build the source
checkout's packages first; the new packages are not available on npm yet:

```sh
pnpm --filter @fluxfast/core build
pnpm --filter @fluxfast/codegen build
pnpm --filter @fluxfast/react build
pnpm --filter @fluxfast/vite build
```

In the consuming frontend, define a page component:

```tsx
// src/flux-pages/home/index.tsx
import { useResource, Link } from "@fluxfast/react";

export default function Home() {
  const greeting = useResource<string>("greeting");
  return <main><h1>{greeting}</h1><Link href="/rooms">Rooms</Link></main>;
}
```

FastAPI's `/` route should select `home/index` and return the `greeting` resource.
Generate the allowlist from the frontend directory using the built Codegen binary:

```sh
node /path/to/FluxFast/packages/codegen/bin/fluxfast-codegen.js generate --adapter react
node /path/to/FluxFast/packages/codegen/bin/fluxfast-codegen.js generate --adapter react --check
```

For all six typed artifacts, first export the authoritative backend schema and
pass `--schema-file PATH`; see [Codegen](codegen-api.md). Do not hand-edit generated
files. The registry exports `FluxApplication`, used identically by SSR/hydration.

Configure the host plugin:

```ts
// vite.config.ts
import { defineConfig } from "vite";
import { fluxfast } from "@fluxfast/vite";

export default defineConfig({
  plugins: [fluxfast({
    forwardHeaders: ["x-tenant-id"],
    cache: { maxPages: 20, maxResources: 100 },
  })],
});
```

Create a separate host template, leaving an existing SPA `index.html` untouched:

```html
<!-- fluxfast.html -->
<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>My FluxFast app</title></head>
  <body>
    <div id="fluxfast-root"><!--fluxfast:ssr--></div>
    <!--fluxfast:payload-->
    <script type="module" src="/@fluxfast/client"></script>
  </body>
</html>
```

Both markers must occur exactly once. `fluxfast-root` and the generated JSON
payload are the shared React hydration contract. The virtual client module
hydrates `FluxApplication`; it does not fetch a new initial envelope or mount an
empty SPA. Application CSS should be imported from your application/page modules
or linked in this trusted template. Vite transforms those assets normally.

Use these frontend scripts after installing the source-built host:

```json
{
  "scripts": {
    "dev": "fluxfast-vite dev",
    "build": "fluxfast-vite build",
    "start": "fluxfast-vite start"
  }
}
```

For now, run FastAPI separately on loopback. Then, from the frontend directory:

```sh
FLUXFAST_BACKEND_URL=http://127.0.0.1:8123 npm run dev -- --port 3000
npm run build
FLUXFAST_BACKEND_URL=http://127.0.0.1:8123 npm start -- --port 3000
```

pnpm or another package manager can run the same scripts. `--hostname` defaults
to `127.0.0.1`; `--port` defaults to `3000`. `build` needs no running backend.
Build/start require `NODE_ENV` to be unset or `production`; the CLI sets it before
loading runtime modules. A development build must not be silently deployed as
production output.
The future Python supervisor integration will own both children through one
command; the current Python CLI still selects only the Next host.

## API reference

These additive integration APIs are intended as Advanced Stable upon v1.2
publication. Import the root only in Node tooling/configuration; the server
entry is Node-only. They must not enter a browser bundle.

<!-- vite-api-examples:start -->
| Export | Declaration/use example | Purpose |
| --- | --- | --- |
| `fluxfast` | `const plugin = fluxfast({ application: "src/application.tsx" });` | Adds the same application to Vite's virtual SSR and hydration entries; does not create a second application router. |
| `FluxViteOptions` | `const options: FluxViteOptions = { applicationExport: "Application", diagnostics: true };` | Describes the trusted application/template and safe cache/header/render settings. |
| `buildFluxViteApp` | `await buildFluxViteApp({ root: "/srv/frontend" });` | Builds client output and a Node renderer without contacting the backend. |
| `FluxViteBuildOptions` | `const build: FluxViteBuildOptions = { root: "/srv/frontend", configFile: "vite.config.ts" };` | Selects the frontend root and optional build-time Vite config. |
| `createFluxViteServer` | `const server = await createFluxViteServer({ mode: "production", backendUrl: "http://127.0.0.1:8123" });` | Listens on one public origin using reviewed production outputs or development Vite middleware. |
| `FluxViteServerOptions` | `const options: FluxViteServerOptions = { mode: "development", host: "127.0.0.1", port: 3000 };` | Selects the runtime mode, public bind and private server-side backend. |
| `FluxViteServer` | `const host: FluxViteServer = await createFluxViteServer(options); await host.close();` | Exposes the listening URL and idempotent graceful cleanup of owned requests, sockets and watchers. |
<!-- vite-api-examples:end -->

### Plugin inputs

`application` defaults to `src/.fluxfast/pages.generated.ts`, and
`applicationExport` to `FluxApplication`. For a root-layout frontend, set
`application: ".fluxfast/pages.generated.ts"`. A custom named application export
must accept `FluxApplicationProps` and use the same registry/context in Node and
the browser; there is no hidden client-only replacement.

`template` defaults to `fluxfast.html` and must identify an HTML file inside the
frontend root. `forwardHeaders` supplements the shared default cookie,
authorization, language and user-agent allowlist; hop-by-hop fields never pass.
`cache` configures Core's bounded stores, not server cache scopes.
`timeoutMs` defaults to 30 seconds for initial fetching and rendering; SSE proxy
streams have no document deadline. `diagnostics: true` opts into safe development
metadata only. Production suppresses trace opt-in and response trace headers.

Exactly one `fluxfast()` plugin and Vite `base: "/"` are required. The plugin
uses automatic JSX and deduplicates React/React DOM. An optional React Vite plugin
may add its usual development transforms; FluxFast applies `transformIndexHtml`
before inserting SSR markup. Use the FluxFast host commands, not Vite's SPA
development server or `vite preview`. Unknown CLI flags fail without startup.
The development host transforms modules on demand rather than starting Vite's
speculative pre-transforms, so a cold dependency scan cannot leave background
transforms waiting after shutdown cancels optimization.

### Server inputs and output

`createFluxViteServer` defaults to development, loopback and port 3000. The optional
`backendUrl` takes precedence over server-only `FLUXFAST_BACKEND_URL`; credentials,
query and fragments in that URL are rejected without reflecting their values.
The incoming Host, forwarded headers and browser data never choose the backend.
Programmatic port `0` requests an ephemeral port; the returned `url` contains the
actual bound port. The CLI intentionally accepts only ports 1–65535.

```ts
import { createFluxViteServer } from "@fluxfast/vite/server";

const server = await createFluxViteServer({
  root: "/srv/frontend",
  mode: "production",
  host: "0.0.0.0",
  port: 3000,
  backendUrl: "http://127.0.0.1:8123",
});
console.log(server.url); // http://0.0.0.0:3000
// On application shutdown:
await server.close();
```

Production rejects `configFile`: it reads the built manifest/template/renderer,
not source Vite configuration. Missing/malformed output or failed module loading
rejects startup before listening. Programmatic callers own their process signal
handlers; the CLI handles SIGINT/SIGTERM once and closes gracefully.

## Production output and request behavior

Build output is fixed at `dist/fluxfast/`: `client/` contains HTML and assets,
`server/renderer.mjs` plus chunks contains the Node renderer, and `host.json`
records the template and static asset allowlist. It contains no backend URL.
Build clears only these owned client/server leaf directories and rejects output
symlinks. The completion manifest is removed before rebuilding and written only
after both builds succeed; a failed partial build cannot masquerade as current.

Deploy those outputs and the declared runtime dependencies. Starting production
does not install packages, generate artifacts, read source configuration or start
Vite. Only recorded regular client files contained in the real client directory
are served as assets. Raw HTML templates, source files, hidden files, server
outputs and source maps are not static responses. Missing reserved assets return
404 instead of an SPA fallback. Application document routes still go to FastAPI.

An exact `X-FluxFast: 1` request bypasses Vite/assets and uses Core's same-origin
proxy at the original path, preserving method/query/body, cookies, streaming and
abort behavior. Separate `Set-Cookie` fields remain separate. Error details never
include private backend exceptions or URLs. HTML requests use actual backend
404/401/403 semantics; malformed or failed SSR produces a safe 500, deadlines 503.

`/fluxfast/healthz` and `/fluxfast/readyz` (with legacy `/_fluxfast/` aliases)
forward only bounded private probes and return `{"status":"ok"}` or
`{"status":"ready"}` on success, otherwise `{"status":"not_ready"}` with 503.
They never forward session headers or expose upstream detail. Closing the host
stops accepting requests, cancels active live streams and releases HTTP/HMR
sockets and development watchers. It does not supervise or stop FastAPI itself.

The implementation follows Vite's documented [SSR middleware/build separation](https://v7.vite.dev/guide/ssr)
and [shared-server HMR option](https://v7.vite.dev/config/server-options#server-hmr),
while keeping FluxFast's authoritative backend and transport model unchanged.
