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

## Stores

`ResourceStore` owns immutable versioned records and key-level subscriptions.
Its bounded LRU keeps values centralized. Stale records may remain visible while
revalidation is in flight, but their versions are excluded from
`X-FluxFast-Known`.

`PageStore` owns only component, URL, and small metadata. `PageCache` stores page
descriptors plus resource versions, never duplicate resource values. A valid
entry allows browser back/forward restoration without a network request.

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
