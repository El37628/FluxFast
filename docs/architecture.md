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

Live Resources add a synchronization path without changing that ownership:

```text
FastAPI page + Resource Engine
          ↓
Page envelope (`resources`, `deferred`, `live`)
          ↓
@fluxfast/core ResourceStore
          ↓
React UI
          ↑
coalesced resource-only canonical refresh
          ↑
LiveManager ← fetch-SSE ← LiveCoordinator ← Memory / Redis broker
```

The broker never owns resource values. It carries scoped invalidation, patch,
or resync signals; canonical state still comes from the page's resource loader.

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

## Live lifecycle

When a capable page envelope contains a non-empty `live` manifest, the Next
provider starts one `LiveManager` connection after hydration. The fetch-SSE
transport sends the authoritative page URL, bounded logical keys, protocol
capabilities, and one opaque per-router client ID. FastAPI reruns the page and
dependencies, authorizes only live keys declared by that page, derives opaque
scoped topics, and subscribes without executing loaders.

An invalidation marks the existing `ResourceStore` record stale and batches
named keys into the same `X-FluxFast-Only` path used by deferred, retry, and
mutation work. A patch first reuses the existing patch engine, then performs the
same canonical refresh. Shared per-key generations prevent older deferred,
live, retry, mutation, or navigation responses from settling over newer work.

Navigation replaces the manifest, aborts obsolete deferred/live work, closes
the old stream, and connects the new page when necessary. `PageCache` stores
the live-key manifest with each descriptor so Back/Forward restoration can
restart the correct connection. Prefetch records manifests but never opens a
stream. SSR seeds the manifest but remains disconnected; React Strict Mode
effect restarts do not invalidate unrelated deferred work. `router.clear()`
closes live state before authenticated browser caches are cleared on logout.

`LiveManager` owns connection status, online/offline transitions, bounded
exponential reconnect, and readiness-triggered canonical resynchronization.
Transport parsing, event validation, and resource synchronization live in
framework-neutral `@fluxfast/core`; `@fluxfast/next` only starts the lifecycle
and exposes `useLiveStatus()`.

## Server coordination

`LiveCoordinator` is the server boundary between scoped resources and a
replaceable `LiveBroker`. It validates reusable scopes, hashes scope plus
logical key into an opaque topic, deletes canonical cache entries before
publication, and isolates publication failure from successful business
mutations.

`MemoryLiveBroker` is async-safe, per-process, and bounded per subscriber. It is
appropriate for development, tests, or exactly one FastAPI process.
`RedisLiveBroker` uses ephemeral Redis Pub/Sub to carry the same validated
signals across workers and hosts. Broker interruption ends the affected stream;
browser reconnect then reloads every active key instead of relying on replay.

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

The in-memory backend resource cache is per process. Cache misses do not cross
an isolation boundary, but scoped invalidation deletes only the current
process's entry. Live publication must also reach streams on other workers, so
multi-worker deployments require `RedisLiveBroker` plus either `ttl=0` for live
resources or a shared/cross-worker-invalidation-aware `ResourceCacheBackend`.
