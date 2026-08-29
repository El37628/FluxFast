# Next.js Adapter

FluxFast supports the Next.js 16 App Router through one optional catch-all shell.
FastAPI remains the application router; Next supplies the document, bundling,
React runtime, and code splitting.

Wrap the Next config to generate the allowlisted lazy registry and proxy only
FluxFast-marked requests to the server-only backend address:

```js
import { withFluxFast } from "@fluxfast/next/next-config";

export default withFluxFast({
  reactStrictMode: true,
});
```

The generated file exports both `fluxPages` and a client-side
`FluxApplication`. Tests, stories, and underscore-prefixed modules are ignored.
`npx fluxfast generate` remains available for explicit regeneration.

```ts
import { defineFluxConfig } from "@fluxfast/next";
import { FluxApplication } from "@/.fluxfast/pages.generated";

export const fluxConfig = defineFluxConfig({
  application: FluxApplication,
  cache: { maxResources: 128, maxPages: 32 },
});
```

```tsx
import { createFluxNextPage } from "@fluxfast/next/server";
import { fluxConfig } from "@/fluxfast.config";

export default createFluxNextPage(fluxConfig);
```

Put that page at `app/(flux)/[[...flux]]/page.tsx`. The helper reconstructs the
path and repeated search parameters, forwards only cookie, authorization,
accept-language, user-agent, and explicitly configured safe headers, and obtains
the initial envelope from FastAPI. It never forwards hop-by-hop headers.

`backendUrl` is server-visible. `clientUrl` is the browser transport base; omit
it for a same-origin reverse proxy. In cross-origin development, configure
FastAPI CORS explicitly and use a public browser-reachable URL.

The recommended development path is one supervised command from the consuming
application:

```bash
.venv/bin/fluxfast dev backend.app.main:app
```

It selects an available FastAPI loopback port, injects that address only into
the Next server process, and starts the frontend on port 3000. The browser uses
relative URLs on the Next origin; the `X-FluxFast: 1` rewrite condition sends
only protocol visits and mutations to FastAPI. Normal document requests remain
owned by the Next catch-all shell, and no CORS configuration is required.

Set `backendUrl` explicitly only when the Next server cannot use the injected
`FLUXFAST_BACKEND_URL`. Set `clientUrl` only for a deliberate cross-origin
deployment.

`Link` renders a normal anchor and intercepts only unmodified left clicks to
same-origin destinations with `_self` targeting and no download attribute.
`usePage`, `useResource`, `useForm`, `useRouter`, and `useFlux` consume the stable
client runtime.
