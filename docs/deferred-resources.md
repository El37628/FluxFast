# Deferred Resources

Deferred resources let a FluxFast page return its renderable shell before
secondary resource loaders finish. They are an additive `fluxfast/1` feature,
negotiated with the `deferred-resources` capability.

`defer=True` applies to a `ResourceSpec.loader`. It does not postpone work done
inside the FastAPI page handler, its dependencies, authentication, validation,
or authorization, and it does not move those responsibilities to Next.js.

## Define a deferred resource

```python
from fastapi import Depends
from fluxfast import Page, resource, scope


@flux.page("/reports")
async def reports(tenant=Depends(current_tenant)):
    return Page(
        component="reports/index",
        resources=[
            resource("report-summary", load_summary),
            resource(
                "report-chart",
                load_expensive_chart,
                scope=scope.tenant(tenant.id),
                ttl=120,
                defer=True,
            ),
        ],
    )
```

On a capable client's initial request, FluxFast resolves `report-summary` and
probes the server cache for `report-chart`. A cache miss is announced as
pending without calling `load_expensive_chart`. After hydration, the browser
sends one resource-only request for the pending keys. Multiple deferred keys
from the same page are batched and their loaders run concurrently.

This is progressive loading through two JSON envelopes, not HTTP streaming:

```text
initial request
  FastAPI page handler + blocking loaders + deferred cache probes
      ↓
  page shell + ready resources + pending keys
      ↓
browser resource-only request
  deferred loaders
      ↓
  ResourceStore updates; PageStore and browser history stay unchanged
```

## Render lifecycle state

Use `useDeferredResource` for data that may not exist during the initial
render:

```tsx
"use client";

import { useDeferredResource } from "@fluxfast/next";

export default function ReportPage() {
  const chart = useDeferredResource<Chart>("report-chart");

  if (chart.error && !chart.data) {
    return (
      <div role="alert">
        <p>{chart.error.message}</p>
        <button onClick={() => void chart.retry()}>Retry chart</button>
      </div>
    );
  }

  if (!chart.data) return <ChartSkeleton />;

  return (
    <section>
      {chart.stale ? <p>Refreshing chart…</p> : null}
      <Chart value={chart.data} />
      {chart.error ? (
        <button onClick={() => void chart.retry()}>Retry chart</button>
      ) : null}
    </section>
  );
}
```

The hook returns `{ data, status, error, stale, retry }`.

| Status | Meaning |
| --- | --- |
| `missing` | The store has no value or pending declaration for the key. |
| `pending` | The initial envelope declared the key for deferred loading. |
| `loading` | A resource-only request is in flight. |
| `ready` | A canonical value is available. |
| `error` | The latest attempt failed; `data` may still contain a stale value. |

`stale=true` means the last value remains renderable but its version is not
sent as known canonical data. `useResource` remains appropriate for guaranteed
blocking resources; it returns `undefined` for unresolved deferred data and
does not expose lifecycle metadata.

`retry()` requests only that logical key from the current FastAPI page. The
page route and dependencies still run to reconstruct the allowed resource
graph, but the response updates only `ResourceStore`; it does not replace the
page component, push history, or reload the document.

## Errors

A capable resource-only request isolates failures from deferred loaders. Other
keys in the batch can become ready while the failing key receives a sanitized
`ResourceError` in `resourceErrors`. The page stays mounted and the hook exposes
that error for a targeted retry.

Blocking resource failures remain page-request failures. A loader declared
with `defer=True` also remains blocking and fatal when the client does not
advertise deferred support. FluxFast does not expose exception details in
production resource errors.

## Caching

Deferral does not disable caching and does not weaken cache isolation:

- A valid deferred server-cache hit is returned in the initial envelope.
- If the client already knows that cached version, the server omits the value
  and does not mark the key pending.
- A cache miss is deferred only on a capable full page request. An explicit
  resource-only request executes the loader.
- `ttl=0` stays uncacheable. Cross-request caching requires an explicit
  `public`, `user`, `tenant`, or `custom` scope.
- The browser `ResourceStore` keeps values independently of server TTL.
  `PageCache` tracks the page's complete resource manifest and can restore
  resolved or still-pending pages on Back/Forward. Evicted or stale resolved
  values invalidate that cached page entry.

The in-memory server cache is process-local. Multiple FastAPI workers can lower
the hit rate, but a miss only reruns the scoped loader and must not change
authorization or isolation.

## SSR, direct loads, and hydration

The Next server advertises `deferred-resources` while fetching the initial
envelope. It seeds pending states into the server-rendered React tree, so the
HTML skeleton and the first hydrated snapshot agree. The browser starts the
pending batch after hydration; startup is idempotent under React Strict Mode.
Direct URL loads and browser reloads follow the same path.

Deferred resources do not use React Suspense or stream loader results into the
initial document. Components should render explicit pending and error states
from `useDeferredResource`.

## Prefetch, navigation, and history

Prefetch probes deferred caches but does not execute deferred cache-miss
loaders. Applying the prefetched envelope during the real visit marks those
keys pending and starts the normal batched request. A newer navigation aborts
the active deferred batch when possible, and per-key generations prevent a
late deferred response from overwriting newer navigation, retry, refresh, or
mutation state even when cancellation races with completion.

Resolved deferred values can be reused through `PageCache`. Returning to a
page with unresolved pending keys restores the shell and starts a fresh batch;
returning with valid resolved keys needs no deferred request.

## Mutations

Mutation invalidation preserves coherence for every deferred state:

- **Ready and subscribed:** the old value becomes stale/loading and remains
  visible while FluxFast requests a canonical replacement for that key.
- **Pending or loading and subscribed:** the current generation is invalidated,
  a newer resource-only request starts, and the older response cannot win.
- **Failed and subscribed:** a new load clears the visible error while it runs;
  another failure returns the key to `error`.
- **Inactive:** the key is removed without an eager request.

Mutation patches and invalidations both advance the resource generation.
Redirects take precedence over mutation-triggered partial revalidation. Server
cache invalidation still needs the exact scope used by the resource; the
logical key in the mutation envelope only coordinates browser state.

If a consumer mounts for an inactive key before another page envelope declares
it, the hook reports `missing`; call `retry()` when that UI should load the key
immediately.

## What to defer

Good candidates are secondary work that can appear after the page structure:

- analytics charts and expensive aggregates;
- activity feeds, recommendations, and audit trails;
- large secondary tables; and
- non-critical dashboard widgets or reports.

Do not defer identity, permissions used to render safely, tenant context, the
page's primary entity, data that controls route authorization, or values needed
for the above-the-fold structure. Those resources should be available before
the component renders.

## Performance

Deferral optimizes time to the initial renderable envelope, not total work. It
adds a resource-only request and a second protocol envelope, so complete
settlement can take slightly longer and transfer slightly more metadata. Batch
related keys instead of triggering one request per component, and keep page
handler work cheap because it runs for both the initial and follow-up requests.

Run `pnpm benchmark` for the controlled 10/100/500 ms comparison and review the
measured initial-latency, total-settlement, and payload tradeoffs in
[benchmarking.md](benchmarking.md).

## Compatibility

The wire protocol remains `fluxfast/1`. A new client sends
`X-FluxFast-Capabilities: deferred-resources`; a server that recognizes it may
add `resourceKeys`, `deferred`, and `resourceErrors`. Missing capability headers
keep `defer=True` resources blocking, so old clients continue receiving a
complete traditional page envelope. Unknown capabilities and optional unknown
fields do not alter v1 behavior.
