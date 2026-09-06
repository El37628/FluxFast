# `@fluxfast/next` public API

FluxFast 0.9 freezes the Next.js adapter's five npm entry points as 1.0
candidates. Import from the path matching the runtime boundary:

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

## Classification

A stable candidate is ordinary application or tooling API. An advanced stable
candidate is a lower-level context, transport, handler, or resolver primitive.
Both categories are compatibility-sensitive and receive the same support.

Every distinct exported name appears exactly once in the following inventory.
Availability through individual entry points is frozen separately below.

### Stable candidates

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

### Advanced stable candidates

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

No `@fluxfast/next` export is deprecated in v0.9.

## Entry-point inventories

The root and `/client` paths intentionally expose the same client API in v0.9.
The explicit `/client` path carries a client-boundary directive; the root remains
the established convenience import. `useLiveStatus` and its snapshot types were
added to `/client` during the freeze review because omitting a client-only hook
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

## Freeze boundaries

This inventory freezes package names, entry paths, and type/value exports. It
does not independently redefine the `fluxfast/1` wire protocol, generated-file
schema, validation semantics, cache behavior, live lifecycle, or CLI flags;
their dedicated v0.9 reviews freeze those contracts. See [Next.js
integration](nextjs-adapter.md), [versioning](versioning.md), [protocol](protocol.md),
and [Live Resources](live-resources.md).
