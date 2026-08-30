# Architecture

FluxFast synchronizes a graph of small resources rather than replacing one
page-sized props object.

```text
FastAPI route + dependencies
          ↓
Page and scoped ResourceSpecs
          ↓
concurrent resource engine + server cache
          ↓
fluxfast/1 envelope
          ↓
@fluxfast/core stores and router
          ↓
@fluxfast/next React subscriptions and page registry
```

FastAPI is authoritative for URLs, authentication, authorization, validation,
mutations, and the component identifier. The frontend registry is authoritative
for mapping that identifier to an allowlisted UI module.

## Blocking and deferred resource flow

A page may divide its resource graph without changing ownership:

```text
FastAPI Page
├── blocking ResourceSpecs ──→ cache probe / loader ──→ initial resources
└── deferred ResourceSpecs ──→ cache probe
                               ├── hit ───────────────→ initial resources
                               └── miss ──────────────→ pending manifest

browser receives renderable page shell
          ↓
pending keys are batched into X-FluxFast-Only
          ↓
same FastAPI page + dependencies reconstruct the allowed graph
          ↓
deferred loaders resolve concurrently
          ↓
ResourceStore updates without PageStore/history navigation
```

This is capability-negotiated progressive loading, not server response
streaming. `defer=True` postpones only the resource loader; FastAPI route work,
dependencies, authentication, validation, and authorization still run before
each envelope. Clients without the `deferred-resources` capability resolve the
same declarations as blocking resources.

The Next server seeds pending resource snapshots into the initial render. After
hydration, the provider starts the batch idempotently. Resource-only completion
does not notify page subscribers or push history. A navigation aborts the active
deferred batch, while per-key generations reject late results that lose a race
with navigation, retry, refresh, or mutation.

## Stores

`ResourceStore` owns immutable versioned records and key-level subscriptions.
Its bounded LRU keeps values centralized. Stale records may remain visible while
revalidation is in flight, but their versions are excluded from
`X-FluxFast-Known`.

`PageStore` owns only component, URL, and small metadata. `PageCache` stores page
descriptors, the complete `resourceKeys` manifest, resolved versions, and which
deferred keys are still pending—never duplicate resource values. A valid entry
allows browser back/forward restoration without a network request. Pending
entries restart their resource batch; a missing, stale, or evicted resolved
resource invalidates the page entry.

## Navigation

Each visit receives an ID and `AbortController`. A superseding visit aborts the
previous request where possible, and the latest visit ID is checked before any
state update. Prefetch requests are deduplicated by URL plus known versions;
prefetched deltas are used only while the versions on which they depended still
exist.

## Development topology

The Next adapter requires a Node runtime for its App Router shell, but this does
not require two browser origins. `fluxfast dev` supervises FastAPI and Next from
one command. FastAPI listens on an automatically selected loopback port known
only to the Next server; the browser uses the Next origin, whose header-gated
rewrite proxies FluxFast protocol requests internally. FastAPI still owns every
application route and resource definition.

## Boundaries

`@fluxfast/core` has no React or Next.js imports. The Next adapter supplies
React external-store hooks, normal-anchor link interception, server bootstrap,
and generated component resolution. This keeps future frontend adapters from
depending on Next-specific behavior.

The in-memory backend cache is per process. Multiple workers can reduce hit rate
but must never change correctness or isolation.
