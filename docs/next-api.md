# `@fluxfast/next` public API

FluxFast 1.x treats the Next.js adapter's five npm entry points as stable.
Import from the path matching the runtime boundary:

| Public path | Intended environment |
| --- | --- |
| `@fluxfast/next` | Application components and hooks |
| `@fluxfast/next/client` | Explicit Next.js client boundaries |
| `@fluxfast/next/server` | Server components and route handlers |
| `@fluxfast/next/generate` | Node.js generation and drift checks |
| `@fluxfast/next/next-config` | `next.config` integration |

Only paths listed in the package's npm `exports` map are public package entry
points. Paths below `@fluxfast/next/dist`, `@fluxfast/next/src`, and other
package internals receive no compatibility guarantee. The published-package
consumer verifies CommonJS `require()`, ESM `import`, and TypeScript declarations
for every public path, and verifies that representative deep imports are blocked.

Use the [Stable APIs guide](stable-apis.md) to choose ordinary application
hooks, form, generation, and shell APIs. Use
[Advanced Stable APIs](advanced-stable-apis.md) only when you deliberately own
server handlers, route context, registry inspection, or provider integration.
This page is the authoritative entry-point and symbol inventory.

## Common API inputs and outputs

These examples follow the runtime boundaries in the table above. Generated
resource keys and validators come from the FastAPI-owned contract; do not
redeclare those types by hand.

### Render a resource in a client component

Given this resource record in the initial envelope:

```json
{
  "rooms": {
    "version": "rooms-v1",
    "value": [{ "id": 101, "status": "available" }]
  }
}
```

the root or `/client` entry point can subscribe to its value and lifecycle:

```tsx
"use client";

import { useResource, useResourceState } from "@fluxfast/next/client";
import { resourceKeys } from "@/.fluxfast/types.generated";

export default function RoomsPage() {
  const rooms = useResource(resourceKeys.rooms);
  const state = useResourceState(resourceKeys.rooms);

  return (
    <main>
      <p>Resource status: {state.status}</p>
      <ul>
        {rooms.map(room => (
          <li key={room.id}>
            Room {room.id}: {room.status}
          </li>
        ))}
      </ul>
    </main>
  );
}
```

Rendered output:

```text
Resource status: ready
Room 101: available
```

`useResource()` is for an available value. Use `useDeferredResource()` when the
server marks a resource deferred; its result adds `isPending`, `isLoading`,
`isReady`, `isError`, and `retry()` to the same state snapshot.

### Reconstruct a server request path

The `/server` entry point converts optional catch-all parameters and Next.js
search parameters into one origin-relative FastAPI path:

```ts
import { buildFluxPath } from "@fluxfast/next/server";

const path = buildFluxPath(
  ["rooms", "101"],
  {
    status: "available",
    tag: ["sea view", "suite"],
  },
);

console.log(path);
```

Output:

```text
/rooms/101?status=available&tag=sea+view&tag=suite
```

`createFluxNextPage()` performs this conversion, forwards only its documented
server-side headers, fetches the initial envelope without caching, and renders
the configured application. A FastAPI 404 invokes Next.js `notFound()` so the
document keeps a real 404 status.

### Inspect generated page registration

The `/generate` entry point can build a registry snapshot without writing any
files. For this directory:

```text
src/flux-pages/
├── home/index.tsx
└── rooms/index.tsx
```

inspect the identifiers that would be generated:

```ts
import { createPagesRegistrySnapshot } from "@fluxfast/next/generate";

const snapshot = createPagesRegistrySnapshot();

console.log({
  identifiers: snapshot.identifiers,
  outputFile: snapshot.outputFile,
});
```

Output (the absolute prefix of `outputFile` depends on the project directory):

```json
{
  "identifiers": ["home/index", "rooms/index"],
  "outputFile": "/project/src/.fluxfast/pages.generated.ts"
}
```

Use `checkFluxFastProject()` for a read-only drift result and
`generateFluxFastProject()` when tooling intentionally owns generated-file
writes. Application code should use the higher-level `fluxfast types` workflow.

### Add the same-origin Next.js transport

`withFluxFast()` belongs in `next.config.ts` through the `/next-config` entry
point:

```ts
import type { NextConfig } from "next";
import { withFluxFast } from "@fluxfast/next/next-config";

const nextConfig: NextConfig = {
  output: "standalone",
};

export default withFluxFast(nextConfig);
```

During supervised production startup, the resulting transport rewrite is:

```json
{
  "source": "/:path*",
  "has": [
    { "type": "header", "key": "x-fluxfast", "value": "1" }
  ],
  "destination": "/_fluxfast/transport/:path*"
}
```

Only requests carrying the FluxFast header match that rule. Normal document
requests stay in Next.js, and the private FastAPI origin is not exposed to the
browser.

## Classification

A stable API is ordinary application or tooling API. An advanced stable API is
a lower-level context, transport, handler, or resolver primitive.
Both categories are compatibility-sensitive and receive the same support.

Every distinct exported name appears exactly once in the following inventory.
Availability through individual entry points is stable separately below.

### Stable

<!-- next-api-stable:start -->
```text
ComponentModule
ComponentRegistry
ComponentRegistryEntry
DEFAULT_FLUXFAST_BACKEND_URL
DeferredResourceResult
FetchInitialEnvelopeOptions
FluxApplicationProps
FluxCacheConfig
FluxFastGenerationCheckResult
FluxFastGenerationOptions
FluxFastGenerationResult
FluxFastNextOptions
FluxNextConfig
FluxNextPageProps
FluxProvider
FluxProviderProps
FluxRoot
FluxRootProps
FluxSearchParams
FormOptions
GenerateOptions
LazyComponentEntry
Link
LinkProps
LiveConnectionStatus
LiveStatusSnapshot
UseFormOptions
UseFormReturn
checkFluxFastProject
createFluxNextPage
defineFluxConfig
fetchInitialEnvelope
generateFluxFastProject
generatePagesRegistry
getComponentRegistry
resolveComponent
resolveFluxBackendUrl
setComponentRegistry
useDeferredResource
useFlux
useFluxContext
useForm
useLiveStatus
usePage
useResource
useResourceState
useRouter
withFluxFast
```
<!-- next-api-stable:end -->

### Advanced stable

<!-- next-api-advanced:start -->
```text
FluxContext
FluxContextValue
FluxHealthHandlerOptions
FluxTransportHandlerOptions
FluxTransportRouteContext
PagesRegistrySnapshot
buildFluxPath
createFluxHealthHandler
createFluxTransportHandler
createPagesRegistrySnapshot
resolveInternalDestination
```
<!-- next-api-advanced:end -->

No `@fluxfast/next` export is deprecated in 1.0.

## Entry-point inventories

The root and `/client` paths intentionally expose the same client API in v0.9.
The explicit `/client` path carries a client-boundary directive; the root remains
the established convenience import. `useLiveStatus` and its snapshot types were
added to `/client` during the v0.9 review because omitting a client-only hook
from the explicit client entry would make the 1.0 contract unnecessarily
inconsistent.

The supported link component is named `Link`. References to “FluxLink” in
planning material describe this component; there is no second alias.

### `@fluxfast/next`

<!-- next-api-entry-root:start -->
```text
ComponentModule
ComponentRegistry
ComponentRegistryEntry
DEFAULT_FLUXFAST_BACKEND_URL
DeferredResourceResult
FluxApplicationProps
FluxCacheConfig
FluxContext
FluxContextValue
FluxNextConfig
FluxProvider
FluxProviderProps
FluxRoot
FluxRootProps
FormOptions
LazyComponentEntry
Link
LinkProps
LiveConnectionStatus
LiveStatusSnapshot
UseFormOptions
UseFormReturn
defineFluxConfig
getComponentRegistry
resolveComponent
resolveFluxBackendUrl
resolveInternalDestination
setComponentRegistry
useDeferredResource
useFlux
useFluxContext
useForm
useLiveStatus
usePage
useResource
useResourceState
useRouter
```
<!-- next-api-entry-root:end -->

### `@fluxfast/next/client`

<!-- next-api-entry-client:start -->
```text
ComponentModule
ComponentRegistry
ComponentRegistryEntry
DEFAULT_FLUXFAST_BACKEND_URL
DeferredResourceResult
FluxApplicationProps
FluxCacheConfig
FluxContext
FluxContextValue
FluxNextConfig
FluxProvider
FluxProviderProps
FluxRoot
FluxRootProps
FormOptions
LazyComponentEntry
Link
LinkProps
LiveConnectionStatus
LiveStatusSnapshot
UseFormOptions
UseFormReturn
defineFluxConfig
getComponentRegistry
resolveComponent
resolveFluxBackendUrl
resolveInternalDestination
setComponentRegistry
useDeferredResource
useFlux
useFluxContext
useForm
useLiveStatus
usePage
useResource
useResourceState
useRouter
```
<!-- next-api-entry-client:end -->

### `@fluxfast/next/server`

<!-- next-api-entry-server:start -->
```text
FetchInitialEnvelopeOptions
FluxHealthHandlerOptions
FluxNextPageProps
FluxSearchParams
FluxTransportHandlerOptions
FluxTransportRouteContext
buildFluxPath
createFluxHealthHandler
createFluxNextPage
createFluxTransportHandler
fetchInitialEnvelope
```
<!-- next-api-entry-server:end -->

### `@fluxfast/next/generate`

<!-- next-api-entry-generate:start -->
```text
FluxFastGenerationCheckResult
FluxFastGenerationOptions
FluxFastGenerationResult
GenerateOptions
PagesRegistrySnapshot
checkFluxFastProject
createPagesRegistrySnapshot
generateFluxFastProject
generatePagesRegistry
```
<!-- next-api-entry-generate:end -->

### `@fluxfast/next/next-config`

<!-- next-api-entry-next-config:start -->
```text
FluxFastNextOptions
withFluxFast
```
<!-- next-api-entry-next-config:end -->

## Contract boundaries

This inventory freezes package names, entry paths, and type/value exports. It
does not independently redefine the `fluxfast/1` wire protocol, generated-file
schema, validation semantics, cache behavior, live lifecycle, or CLI flags;
their dedicated v0.9 reviews document those contracts. See [Next.js
integration](nextjs-adapter.md), [versioning](versioning.md), [protocol](protocol.md),
and [Live Resources](live-resources.md).
