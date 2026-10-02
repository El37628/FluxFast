# React bindings API (unreleased v1.2)

`@fluxfast/react` contains the React bindings shared by frontend hosts. It is
**unreleased development**, not yet an npm release or a complete React SSR/Vite
host. Existing applications keep using `@fluxfast/next`; those exports point to
the same context, components, hooks, resolver state, and types. Next remains the
only implemented host until the separate SSR/Vite integration is complete.

The bindings entry point, `@fluxfast/react`, supports CommonJS, ESM, and
TypeScript. It requires React and React DOM 19+. Its browser import graph has
no Next dependency, backend address, server fetcher, or code generator.
Separate `@fluxfast/react/client` and Node-only `@fluxfast/react/server` entries
provide the unreleased [SSR/hydration boundary](react-ssr.md) for host authors;
they are not re-exported through the bindings root.
Deep imports into package `src`/`dist` are not supported. Core remains independent
of React; FastAPI remains authoritative for routes, resources, and mutations.

## First example: render the envelope, not a second route table

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

For this initial envelope:

```json
{
  "protocol": "fluxfast/1",
  "page": { "component": "rooms/index", "url": "/rooms" },
  "resources": {
    "rooms": { "version": "rooms-v1", "value": [{ "id": 1, "name": "Meeting room" }] }
  }
}
```

The rendered page includes `<ul><li>Meeting room</li></ul>` on the server and
the first client render. Reading a resource does not run a backend loader: the
hook subscribes to the ready value seeded in Core. The host must provide the
**same** initial envelope for SSR and hydration, encode its data safely, serve
the document/assets, and proxy Flux protocol requests through the browser's
origin. `clientUrl` is a transport prefix, not the private backend address.

Do not call `createRoot` in place of hydration for server-rendered markup. Do not
invent client-only routes, duplicate resource values in page props, or start live
streams while rendering SSR. See the [adapter contract](adapter-contract.md) for
the complete host requirements.

## Application APIs

The existing [Next binding reference](next-api.md) also documents their unchanged
behavior. The import owner differs; Next application imports do not need changing.

| API | Purpose and result |
| --- | --- |
| `FluxRoot` | Render the current server-selected component inside a provider, with suspense and a resettable rendering error fallback. Requires an explicit allowlisted `registry`. |
| `FluxProvider` | Supply a shared Core router and registry for custom layouts/children. An owned router starts history, initial deferred work, and live synchronization after hydration; effects stop their listeners/streams on cleanup. |
| `Link` | Render a normal anchor; intercept only eligible unmodified internal clicks. Supports prefetch-on-hover, replace, and preserved scroll. External, modified, download, target, and hash-only navigation retains browser behavior. |
| `useFlux` | Return `{ router, registry }` from the provider. Requires the provider's context. |
| `useRouter` | Return the existing Core router; use its `visit`, `prefetch`, `loadResources`, and `clear` operations instead of adding another navigation engine. |
| `usePage` | Subscribe to the current `PageState`, including component, URL/query, and metadata. Updates on authorized Core navigation/history changes. |
| `useResource` | Subscribe to one resource value. Generated keys infer their types; explicit generics and dynamic strings remain supported. Use deferred/state hooks for values that are not ready. |
| `useResourceState` | Subscribe to one stable snapshot containing `data`, `status`, `error`, and `stale`. Resource changes need not rerender unrelated resource consumers. |
| `useDeferredResource` | Add `isPending`, `isLoading`, `isReady`, `isError`, and `retry()` to the resource state. A failure can be retried without replacing the page or successful siblings. |
| `useLiveStatus` | Observe connection state, reconnect attempts, and last event time; does not open another live connection. SSR reports idle. |
| `useForm` | Own local form input/error/submission state and delegate business mutations to Core. Optional generated validators prevent invalid local submissions; server validation remains authoritative. |

### Deferred state and explicit retry

```tsx
import { useDeferredResource } from "@fluxfast/react";

function Analytics() {
  const report = useDeferredResource<{ total: number }>("analytics");
  if (report.isPending || report.isLoading) return <p>Loading analytics…</p>;
  if (report.isError) return <button onClick={() => void report.retry()}>Retry</button>;
  return <p>Total: {report.data?.total}</p>;
}
```

If FastAPI declares `analytics` as deferred, SSR renders the fallback, hydration
preserves that pending state, and the provider starts the deferred batch in the
browser. Once it settles, only subscribers to the changed resource update.

### Mutation input and validation output

```tsx
import { useForm } from "@fluxfast/react";
// Import a validator generated from the authoritative Python contract:
import { RegistrationInputValidator } from "./.fluxfast/validators.generated";
import type { RegistrationInput } from "./.fluxfast/types.generated";

function Registration() {
  const form = useForm<RegistrationInput>(
    { name: "", email: "", address: { city: "", postcode: "" } },
    { validator: RegistrationInputValidator },
  );
  return (
    <form onSubmit={form.submit("/register")}>
      <input value={form.data.name} onChange={e => form.setData("name", e.target.value)} />
      <input type="email" value={form.data.email} onChange={e => form.setData("email", e.target.value)} />
      <input value={form.data.address.city} onChange={e => form.setData("address", { ...form.data.address, city: e.target.value })} />
      <input value={form.data.address.postcode} onChange={e => form.setData("address", { ...form.data.address, postcode: e.target.value })} />
      <p role="alert">{form.errors.name}</p>
      <button disabled={form.processing}>Register</button>
    </form>
  );
}
```

Use an initial shape matching the generated validator. Invalid local input sets
the issues/error map and sends no mutation; an authoritative backend 422 sets
server field errors. Success applies the server mutation envelope through Core
and marks `wasSuccessful`/`recentlySuccessful`. Transport failures are not
relabelled as validation errors. Validator names depend on the Python contract.

## Advanced integration APIs

| API | Purpose |
| --- | --- |
| `FluxContext`, `useFluxContext` | Share the exact `{ router, registry }` identity with custom React integrations or DevTools. Next re-exports the same context, not a second provider universe. |
| `resolveComponent` | Resolve a backend identifier against an explicit registry or configured global registry. Unknown identifiers throw a controlled Core `ComponentResolutionError`. Lazy entries reuse a stable React.lazy wrapper. |
| `setComponentRegistry`, `getComponentRegistry` | Set/read the legacy global resolver registry. Prefer per-provider registries for SSR so applications/requests do not share mutable module-level configuration. |
| `resolveInternalDestination` | Return an eligible same-origin path/query/hash, or `null` for an external or hash-only destination. It does not perform navigation. |

The following examples cover every exported value and type. Types describe
configuration and results; they are not runtime constructors. Application APIs
and their props/results are intended as Stable; context/resolver and diagnostic
integration APIs are Advanced Stable when v1.2 ships. Both tiers preserve their
documented contract; “advanced” describes the audience, not weaker compatibility.

<!-- react-api-examples:start -->
| Export | Declaration or use |
| --- | --- |
| `FluxRoot` | `<FluxRoot initialEnvelope={envelope} registry={registry} />` |
| `FluxProvider` | `<FluxProvider initialEnvelope={envelope} registry={registry}>{children}</FluxProvider>` |
| `Link` | `<Link href="/rooms" replace preserveScroll>Rooms</Link>` |
| `useFlux` | `const { router, registry } = useFlux();` |
| `useRouter` | `const router = useRouter();` then `await router.visit("/rooms?available=1");` in an event handler |
| `usePage` | `const { component, url } = usePage();` |
| `useResource` | `const rooms = useResource<Array<{ id: number }>>("rooms");` |
| `useResourceState` | `const { data, status, error, stale } = useResourceState("rooms");` |
| `useDeferredResource` | `const report = useDeferredResource("analytics");` |
| `useLiveStatus` | `const { connected, reconnectAttempt } = useLiveStatus();` |
| `useForm` | `const form = useForm({ name: "" });` |
| `FluxContext` | `const runtime = useContext(FluxContext);` (import `useContext` from React) |
| `useFluxContext` | `const { router } = useFluxContext();` |
| `resolveComponent` | `const Page = resolveComponent("rooms/index", registry);` |
| `setComponentRegistry` | `setComponentRegistry({ "rooms/index": Rooms });` |
| `getComponentRegistry` | `const registry = getComponentRegistry();` |
| `resolveInternalDestination` | `resolveInternalDestination("/rooms", "https://app.example/current"); // "/rooms"` |
| `FluxRootProps` | `const props: FluxRootProps = { initialEnvelope: envelope, registry };` |
| `FluxProviderProps` | `const props: FluxProviderProps = { initialEnvelope: envelope, registry, children };` |
| `FluxApplicationProps` | `const props: FluxApplicationProps = { initialEnvelope: envelope };` |
| `FluxCacheConfig` | `const cache: FluxCacheConfig = { maxResources: 100, maxPages: 20 };` |
| `FluxDevelopmentMetadata` | `const metadata: FluxDevelopmentMetadata = { initialPath: "/rooms", initialServerTrace: trace };` (safe development-only server metadata) |
| `FluxContextValue` | `const value: FluxContextValue = { router, registry };` |
| `LinkProps` | `const props: LinkProps = { href: "/rooms", prefetch: "hover" };` |
| `DeferredResourceResult` | `const state: DeferredResourceResult<number> = useDeferredResource<number>("count");` |
| `FormOptions` | `const options: FormOptions = { method: "POST", preserveScroll: true };` |
| `UseFormOptions` | `const options: UseFormOptions<{ name: string }> = { validator };` |
| `UseFormReturn` | `const form: UseFormReturn<{ name: string }> = useForm({ name: "" });` |
| `LiveConnectionStatus` | `const status: LiveConnectionStatus = "idle";` |
| `LiveStatusSnapshot` | `const live: LiveStatusSnapshot = useLiveStatus();` |
| `ComponentModule` | `const module: ComponentModule = { default: Rooms };` |
| `LazyComponentEntry` | `const entry: LazyComponentEntry = { load: () => import("./flux-pages/rooms") };` |
| `ComponentRegistryEntry` | `const entry: ComponentRegistryEntry = Rooms;` |
| `ComponentRegistry` | `const registry: ComponentRegistry = { "rooms/index": Rooms };` |
<!-- react-api-examples:end -->

## Lifetime and session boundaries

Keep the initial envelope and router stable across rerenders. A custom `router`
belongs to its caller: the provider attaches/detaches live work but does not
start its history or initial deferred bootstrap, or permanently destroy it.
SSR must not mutate a global registry per request. At logout or tenant/session
transition, clear the browser router and retain explicit backend resource scopes;
client cleanup never replaces authorization.

Production excludes DevTools and SSR trace metadata. There is no browser Node
`process` requirement, and neither Core/server nor Codegen belongs in this
package's browser graph. See [stability](stability.md), [generated
artifacts](generated-artifacts.md), and the [adapter contract](adapter-contract.md).
