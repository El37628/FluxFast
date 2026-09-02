# Architecture

FluxFast synchronizes a graph of small resources rather than replacing one
page-sized props object.

```text
FastAPI route + dependencies
          ↓
Page and scoped ResourceSpecs
          ↓
concurrent resource engine
          ↓
MemoryResourceCache (one process) / RedisResourceCache (shared workers)
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

Distributed resource coherence is also a server-only concern:

```text
worker A ─┐
worker B ─┼─→ RedisResourceCache ─→ native TTL + opaque tag indexes
worker C ─┘
```

The resource engine uses the existing `ResourceCacheBackend` interface, so
Redis adds no browser capability or wire field. A shared warm entry can be read
through any worker. Simultaneous cold misses may still execute several loaders;
FluxFast deliberately does not add a distributed loader lease.

Typed resource contracts add a developer-tooling path without changing either
runtime protocol:

```text
FastAPI-owned ResourceContract + registered page/mutation metadata
          ↓ offline export; application handlers are not executed
fluxfast-schema/1 manifest + deterministic fingerprint
          ↓ validated Node compilation
generated resource types, keys, routes, mutations, and page registry
          ↓ TypeScript module augmentation
@fluxfast/core FluxResourceMap → adapter hook inference
```

The Python application remains the source of truth. On a typed resource cache
miss, Pydantic validates and serializes the loader value before versioning and
caching; the exported schema describes that same JSON wire representation.
The manifest is a build-time artifact, not a production endpoint. It is
versioned independently from both the `fluxfast/1` browser envelope and the
internal Redis cache encoding, so typed generation requires no browser
capability or runtime schema delivery. See [typed resource contracts and code
generation](type-safety.md) and
[ADR-0006](decisions/0006-typed-resource-contracts.md).

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

`MemoryResourceCache` is also per-process. `RedisResourceCache` shares scoped
values, TTL, deletion, tag invalidation, and namespace-safe clearing across
workers. It stores bounded schema-versioned JSON under opaque identities and
uses strict failure semantics: Redis errors are visible instead of silently
falling back to a local cache. The cache and live broker have separate explicit
namespaces and lifecycles because stored values and ephemeral signals are
different responsibilities.

## Development topology

The Next adapter requires a Node runtime for its App Router shell, but this does
not require two browser origins. `fluxfast dev` supervises FastAPI and Next from
one command. FastAPI listens on an automatically selected loopback port known
only to the Next server; the browser uses the Next origin, whose header-gated
rewrite proxies FluxFast protocol requests internally. FastAPI still owns every
application route and resource definition.

## Production topology

`fluxfast build` validates the initialized adapter and generated contracts,
then creates the production Next.js output with the frontend's installed
package manager. `fluxfast start` consumes that immutable output and supervises
the supported servers as one foreground service:

```text
external process manager or OCI runtime
        |
        `-- fluxfast start
              |-- Next.js   public origin
              `-- FastAPI   private loopback origin
```

FastAPI becomes ready before Next.js starts. The supervisor injects the private
backend URL into the Next.js child as server-only configuration; documents,
navigation, mutations, deferred requests, Live Resource streams, and public
health probes all remain on the Next.js origin. A normal production deployment
therefore exposes one port and does not require browser CORS configuration.

SIGTERM and SIGINT stop both process groups within a bounded grace period. An
unexpected child exit stops its sibling and fails the service. Uvicorn owns its
configured worker pool; Redis remains the cross-process cache and live-signal
boundary when more than one worker or application instance needs coherence.
The same topology runs as a host process, as PID 1 in Docker, and in rootless
Podman.

See [production deployment](production.md), [container
deployment](containers.md), and
[ADR-0007](decisions/0007-production-runtime.md) for the operational contract
and its rationale.

## Boundaries

`@fluxfast/core` has no React or Next.js imports. The Next adapter supplies
React external-store hooks, normal-anchor link interception, server bootstrap,
generated component resolution, and the current TypeScript schema compiler.
Generated resource types augment the framework-neutral `FluxResourceMap`; the
core package does not import Pydantic, generated application modules, React, or
Next.js. This keeps future frontend adapters from depending on Next-specific
behavior.

The in-memory backend resource cache is per process. Its cache misses do not
cross an isolation boundary, but scoped invalidation deletes only the current
process's entry. Multi-worker live deployments therefore have two valid
topologies: `RedisLiveBroker` with `MemoryResourceCache` and `ttl=0`, or
`RedisLiveBroker` with `RedisResourceCache` and positive TTLs. See
[distributed resource coherence](distributed-cache.md) for the complete
topology, failure, security, and lifecycle contract.
