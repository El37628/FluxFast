# @fluxfast/react

Host-independent React bindings for FluxFast. This package is **unreleased
v1.2 development**, not yet an installable registry release or a standalone
SSR host. Existing Next.js applications continue importing `@fluxfast/next`;
that adapter re-exports the same context, components, hooks, and types.

FastAPI owns application URLs, authentication, resource loading, validation,
and mutations. These bindings subscribe to `@fluxfast/core`; they do not
introduce another router or resource cache. A host supplies SSR, the HTML
document, safe serialization, hydration, assets, and same-origin transport.

## Render a server-selected page

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

Given an envelope selecting `rooms/index` with a ready `rooms` resource, SSR
renders its list. The host must hydrate from that same envelope. `FluxRoot`
starts history, deferred work, and live subscriptions only after hydration.
Unknown component identifiers fail against the explicit registry; they never
become arbitrary module paths. Use `Link` for eligible same-origin visits,
`useResourceState` for status/errors/staleness, `useDeferredResource` for deferred
values and retry, `useLiveStatus` for connection state, and `useForm` for mutations
and generated client validation. These retain the existing Next binding semantics.

For custom layouts, `FluxProvider` accepts the same envelope and registry and
wraps children that use these hooks. `FluxContext` and `useFluxContext` expose
the shared runtime to integration authors. Core owns navigation, caching,
deferred authority, mutation patches, and live synchronization.

See the [adapter contract](../../docs/adapter-contract.md) for the host lifecycle
and [React API reference](../../docs/react-api.md) for the complete binding API.
