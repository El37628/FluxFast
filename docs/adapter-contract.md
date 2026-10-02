# Frontend adapter implementation contract

This is the implementation contract for an SSR-capable FluxFast frontend
adapter, not an application setup guide. It defines observable behavior and
ownership; it does not require another adapter to reproduce Next.js internals.
Application developers should start with the [Next.js adapter](nextjs-adapter.md)
and [Stable APIs](stable-apis.md).

Next.js is the only implemented frontend host. The multi-adapter foundation on
`main` is **unreleased v1.2 development**: `@fluxfast/core/server` and
`@fluxfast/codegen` are not available in published v1.1 packages. This document
does not announce a React or Vite adapter, a React SSR host, or a new release.
Existing Next.js applications retain their imports, generated filenames, CLI
entry points, and deployment behavior.

“Must” below identifies a required behavior. The [wire protocol](protocol.md)
remains `fluxfast/1`, and the [developer schema](developer-schema.md) remains
`fluxfast-schema/2`; neither is versioned by the adapter's package version.
Optional capability fields must retain their documented legacy fallback.

## Ownership

| Layer | Owns | Must not take over |
| --- | --- | --- |
| FastAPI / Python FluxFast | Application route intent, authentication, authorization, dependency injection, runtime validation, resource loading and scopes, versions and cache semantics, business mutations, and live publication | Frontend document construction, module loading, or hydration |
| `@fluxfast/core` | Protocol validation, browser resource synchronization, navigation/history coordination, bounded stores and caches, mutation reconciliation, deferred authority, and live synchronization | UI rendering, framework APIs, application authorization, or adapter environment lookup |
| `@fluxfast/core/server` | Framework-neutral initial envelope fetching, safe HTTP headers, redirect handling, and streaming transport proxying | Component selection policy, rendering, host 404 control flow, or process supervision |
| `@fluxfast/codegen` | Framework-neutral schema compilation, validators/types/routes/mutations, page scanning, and artifact persistence through an explicit adapter target | Choosing an installed frontend implicitly or introducing a runtime dependency on Next.js |
| Frontend adapter / host | HTML document, SSR, allowlisted component loading, UI subscriptions and rendering, hydration, assets/chunks, framework request integration, and lifecycle bindings | A second application router, resource loader, cache authority, or patch/live engine |

FluxFast does not require FastAPI to render a frontend root template. There is
no required equivalent of `app.blade.php`: the frontend host owns the document,
and FastAPI returns the authoritative envelope. A catch-all frontend entry
delegates application route intent to FastAPI rather than maintaining a second
copy of its route definitions. See [architecture](architecture.md) and
[ADR-0002](decisions/0002-nextjs-shell.md).

Core's browser root must remain free of React, Next.js, Vue, Svelte, Solid,
Node-only server imports, and adapter imports. Adapter authors must use public
package entry points, not another adapter's `src` or `dist` internals. Server
primitives belong in server code; Codegen belongs in build/development tooling,
not the browser graph. Framework-specific directives and registry import paths
are adapter-target inputs, not defaults hidden in the generic compiler.

## Initial request and SSR

```text
Browser hard navigation
  → frontend SSR host
  → private FluxFast backend request
  → validated PageEnvelope
  → allowlisted component resolution
  → meaningful HTML + the same initial envelope
  → browser hydration
```

A hard navigation must return meaningful server-rendered HTML for the selected
page and its blocking resources. Returning only `<div id="root"></div>` and
requiring client-side fetching to produce the page does not satisfy this
contract. A deferred resource may render a fallback; an adapter must not defer
the entire page merely to avoid SSR.

The server boundary must:

1. Preserve the requested encoded path and query, including repeated query
   parameters. If the framework supplies decoded catch-all segments, encode
   each segment exactly once; do not flatten a segment containing `/` into a
   new route.
2. Obtain the private backend address from trusted server configuration. Never
   let an incoming hostname, query, header, or browser bundle choose it.
3. Forward the incoming authentication context using safe header selection.
   The default SSR allowlist includes cookie, authorization, language, and
   user-agent; application-specific headers require an explicit allowlist.
   Connection-nominated and standard per-hop fields must not cross the boundary.
4. Request and validate a FluxFast envelope without HTTP response caching.
   Advertise supported capabilities and retain safe behavior with older servers.
5. Resolve the backend's component identifier against a generated or explicit
   frontend allowlist. Never turn an arbitrary backend string into an import
   path. An unknown component is a controlled resolution failure, not permission
   to load a module outside the registry.
6. Render using that envelope and hand the identical logical state to hydration.
   Keep diagnostics separate from the envelope and keep credentials/private
   backend configuration out of serialized frontend props.

The following **server-only**, adapter-owned function illustrates the shared
HTTP boundary. It is not a new exported host or rendering API:

```ts
import {
  fetchFluxInitialPage,
  selectFluxForwardHeaders,
} from "@fluxfast/core/server";

export async function readInitialPage(request: Request, backendUrl: string) {
  const url = new URL(request.url);
  return fetchFluxInitialPage({
    backendUrl,
    path: url.pathname + url.search,
    headers: selectFluxForwardHeaders(request.headers, ["x-csrf-token"]),
    diagnostics: false,
  });
}
```

Given a backend route selecting `rooms/index`, the result has
`type: "page"` and `envelope.page.component === "rooms/index"`. The host must
render its allowlisted page and use `result.envelope` as initial state. A valid
backend HTTP 404 returns `{ type: "not-found" }`; the host must translate that
into its actual HTTP 404/not-found mechanism, not a successful 200 fallback.
The helper does not render HTML or call a framework's `notFound()`.

### Redirects and failures

Initial backend canonical HTTP redirects may be followed only within the
configured backend origin, with a bounded redirect count. Cross-origin or
credential-bearing redirects must be rejected before contacting the target;
this is not the explicit mutation `externalRedirect` feature. Do not allow a
native fetch's automatic redirect policy to leak session headers.

`fetchFluxInitialPage` uses manual redirects, validates the final envelope, and
bounds untrusted HTTP error bodies to one MiB. Discarded streams must be
cancelled without waiting on a tee branch retained by the host, otherwise an
SSR fetch-deduplication implementation can deadlock. Successful application
resource values are not subject to that error-body limit.

The host must retain meaningful HTTP error/not-found behavior and must not
render an arbitrary non-Flux JSON/HTML backend response as a page. It must not
convert malformed responses, transport failures, or authorization failures
into an invented valid page envelope. The [Core API](core-api.md#server-adapter-primitives-unreleased-v12)
documents the precise parse, error, redirect, and configuration boundaries.

## Hydration and adapter lifetime

The browser must hydrate from the same initial `PageEnvelope` used for SSR:
component, URL/query, metadata, resource values, opaque versions, full resource
manifest, resource errors, deferred keys, and live keys. Hydration must not
immediately refetch identical blocking resources or generate new versions.
Serialize using the host's safe data/HTML mechanism; unescaped JSON inserted
into a script is not a substitute for a safe hydration payload.

The initial resource snapshots must be available during SSR and the first
browser render. Subscriptions must follow the framework's external-store
contract: stable snapshots when state is unchanged, key-specific resource
notifications, and a server snapshot consistent with the initial envelope.
Component module loading and suspense mechanisms remain adapter-owned.

Create one browser runtime for an application lifetime, not one on every render.
History listeners, initial deferred work, and live connections begin only in
the browser after hydration. SSR seeds manifests but must not open a live
stream or start a deferred follow-up. For example, an adapter can own this
lifecycle binding over the existing public Core methods:

```ts
import { FluxRouter, createFetchTransport, type PageEnvelope } from "@fluxfast/core";

export function createBrowserBinding(initialEnvelope: PageEnvelope) {
  const router = new FluxRouter({
    initialEnvelope,
    transport: createFetchTransport(), // Same-origin transport; no backend port.
    deferHistory: true,
  });

  return {
    router,
    attachAfterHydration() {
      router.startHistory();
      void router.startInitialDeferred().catch(() => undefined);
      // Resource failures are exposed through resource state; render that state.
      router.startLive();
      return () => {
        router.stopLive();
        router.stopHistory();
      };
    },
    dispose() {
      router.destroy(); // Permanent disposal, not a reversible effect cleanup.
    },
  };
}
```

The adapter still supplies framework rendering and subscriptions before calling
`attachAfterHydration`. Repeated development effect setup/cleanup cycles must
leave one history binding and at most one active live stream, without restarting
the initial deferred batch. Keep the runtime stable through those cycles;
`destroy()` is reserved for permanent lifetime disposal. Release component and
diagnostic subscriptions at their owning lifetimes as well.

On logout or an authentication/tenant boundary change, clear browser state with
`router.clear()` before reusing it for the next session. Old visits, resource
loads, mutations, and live work must not populate the new session. Backend
cache isolation still requires explicit server scopes; clearing a browser
store is not authorization or server-cache invalidation.

## Hydrated navigation and component resolution

```text
Link / router.visit
  → same-origin Flux request with known versions
  → validated PageEnvelope delta
  → Core ResourceStore + PageStore
  → allowlisted component transition
```

A normal hydrated FluxFast navigation must not require a document reload. Bind
the framework UI to Core's page/resource state; do not add a competing navigation
authority or apply envelopes independently of the router.

The adapter must support:

- Push and replace navigation, query-preserving URLs, and scroll-preservation
  options through `router.visit`.
- Browser Back/Forward through Core history. A valid page-cache entry restores
  its descriptor using centralized resources; missing, stale, or evicted
  prerequisites require canonical loading. Never keep duplicate resource values
  in a second page cache.
- Ordinary anchors for links. Intercept only eligible unmodified internal
  clicks; retain browser behavior for external destinations, hash-only anchors,
  modified/middle clicks, downloads, and non-self targets.
- Prefetch through Core's deduplicated, bounded prefetch path. Consuming a valid
  prefetch must not fetch twice. Prefetch must not change history, render a
  different page, open its live stream, or overwrite newer authoritative state.
- Superseding navigation cancellation and latest-response authority. Even when
  a transport ignores abort, a late old response must not replace the new page
  or overwrite resources changed by newer work.

These are existing Core operations, not methods to reimplement in an adapter:

```ts
import type { FluxRouter } from "@fluxfast/core";

export async function showAvailableRooms(router: FluxRouter) {
  await router.prefetch("/rooms?status=available");
  await router.visit("/rooms?status=available", {
    replace: true,
    preserveScroll: true,
  });
}
```

The server still chooses `page.component`; changing the browser URL does not
authorize a frontend-only route or resource. Loading a registry module is a
frontend operation, not another backend route lookup.

## Resources, deltas, refresh, and errors

The adapter must subscribe to `ResourceStore` rather than copy values into
page-sized props and attempt to reconcile them separately. A resource snapshot
exposes `data`, `status`, `error`, and `stale`; these are distinct states. Render
pending/loading fallbacks and recoverable error/retry UI without discarding
successful sibling resources.

```ts
import type { FluxRouter } from "@fluxfast/core";

export function observeRooms(router: FluxRouter, notifyUI: () => void) {
  const unsubscribe = router.resourceStore.subscribe("rooms", notifyUI);
  const read = () => router.resourceStore.getStateSnapshot("rooms");
  return { read, unsubscribe };
}

export async function refreshRooms(router: FluxRouter) {
  await router.refresh({ only: ["rooms"] });
}

export async function retryRooms(router: FluxRouter) {
  await router.loadResources(["rooms"], { reason: "retry" });
}
```

`read()` initially returns the SSR-seeded state; `notifyUI` lets the framework
reread it when that key changes. `refreshRooms` and `retryRooms` update resource
state without changing the current component, URL, browser history, or unrelated
resources. Releasing `unsubscribe` is the adapter's responsibility.

An omitted resource in a known-version delta means “retain the existing value,”
not “delete it.” Versions are opaque server-owned strings. Only valid, non-stale
records may participate in `X-FluxFast-Known`; an evicted record must not be
advertised as known. The full `resourceKeys` manifest includes ready, omitted,
pending, live, and failed keys; `Object.keys(envelope.resources)` is not a
substitute for that manifest.

Partial requests use the current authoritative page and `X-FluxFast-Only`.
FastAPI reconstructs that page's dependencies and authorized graph on each
request. They are not global resource-key lookup endpoints. Resource-only
responses must not apply their page descriptor as navigation state. Resource
and page limits, stale-data behavior, and race authority belong to Core; do not
replace them with unbounded adapter maps or an implicit browser persistent cache.

See [caching](caching.md) and [Core API](core-api.md) for exact store and cache
semantics. Authentication/tenant scopes are server-owned and must never be
derived from browser resource keys.

## Deferred resources

For a page with blocking `auth` and `rooms`, and deferred `analytics`, SSR may
render `auth + rooms + analytics fallback`. Hydration preserves that exact
pending state, then Core batches the pending keys into one resource-only load.
If `analytics` was a valid cache hit, it is already ready/known and must not
trigger an unnecessary deferred request.

The adapter must expose pending/loading/ready/error snapshots, retain successful
siblings if another key fails, and expose retry through the same canonical
partial-load path. Resolving deferred work must not notify page subscribers or
push history. Navigation aborts obsolete work; per-key generations must also
reject late results when abort is ignored or a newer refresh, retry, mutation,
or live load has become authoritative. Cached Back/Forward restoration must
retain resolved values or restart still-pending work appropriately.

Deferred loading is capability-negotiated progressive resource loading, not
SSR response streaming and not postponement of authentication or FastAPI
dependencies. A client without `deferred-resources` receives blocking behavior;
an old server without the additive manifests remains usable. See
[Deferred Resources](deferred-resources.md).

## Mutations, validation, patches, and redirects

Send mutations through `router.mutate` and expose success/validation/error state
to application UI. Generated native client validation may prevent an invalid
submission for immediate feedback, but FastAPI/Pydantic remains authoritative;
an HTTP 422 must not patch resources or replace page state.

```ts
import type { FluxRouter } from "@fluxfast/core";

export async function reserveRoom(router: FluxRouter, roomId: number) {
  return router.mutate("/rooms/reserve", { room_id: roomId });
}
```

This example assumes that the backend declares `/rooms/reserve` and accepts
`room_id`; the returned `MutationEnvelope` is reconciled by Core before the
promise resolves. An adapter must not apply the same patches a second time.

Support all five ordered patch operations unchanged: `replace-resource`,
`merge-object`, `replace-item`, `remove-item`, and `append-item`. Core applies
patches first, invalidations second, then the eligible canonical resource load
or redirect. Subscribed invalidated values remain visibly stale during refresh;
UI must not pretend that the old value is newly validated. Do not synthesize
server versions or add optimistic mutation semantics.

An internal mutation redirect is an origin-relative hydrated visit. A 404 on
that visit falls back to document navigation so the host can render its genuine
not-found page. An explicit validated HTTP(S) `externalRedirect` takes
precedence and performs full-browser navigation; it is not an SSR backend fetch
redirect. A late mutation redirect cannot take over a newer navigation or a
cleared session. Keep the existing protocol validation and lifecycle authority
instead of interpreting raw response locations independently.

See [mutations](mutations.md), [Native Client Validation](validation.md), and
the [mutation envelope](protocol.md#mutation-envelope) for field/error details.

## Live resources and reconnect

Seed the initial `live` manifest without connecting on the server. After
hydration, bind Core's `LiveManager` lifecycle and status to the adapter:

- Open at most one active fetch-SSE connection for the current non-empty
  manifest. An empty or absent manifest opens none. The request stays on the
  frontend origin and sends the authoritative page URL, bounded logical keys,
  negotiated capabilities, and the router's opaque client ID.
- Keep the same client ID for that router's mutations and live stream. Suppress
  only its own echoed event; another tab has a different identity and must
  receive scoped updates.
- Treat live events as synchronization signals, not authoritative values or a
  durable event log. Invalidation marks stale state and batches canonical partial
  loading. A patch may render immediately through the existing patch engine,
  then verify canonical state; a missing record needs canonical loading.
- Preserve offline status, bounded reconnect, and readiness-triggered canonical
  resynchronization. Streams can drop events; do not assume replay, exactly-once
  delivery, or a `Last-Event-ID` contract.
- Replace subscriptions on navigation and restore the correct manifest on
  Back/Forward. Stop obsolete streams/work and ignore late events. Resource
  epochs shared with deferred/refresh/mutation work prevent an old canonical
  load from settling over newer state.
- Ignore/reject malformed, unsupported, oversized, and out-of-manifest events
  without mutating resources. Server-derived user/tenant scopes must remain
  isolated; a requested key cannot grant access to a different scope.

SSR and prefetch must never start a live stream. Development effect restarts
must not duplicate streams/listeners or cancel unrelated deferred authority.
Do not implement polling or a second event reconciler in the adapter. See
[Live Resources](live-resources.md), [live deployment](live-deployment.md), and
[distributed cache](distributed-cache.md) for the existing server topology.

## HTTP transport and production lifecycle

The supported topology remains one public frontend origin and a private FastAPI
runtime. Documents, hydration assets, navigation, mutations, deferred requests,
live streams, and public health probes must work without a browser backend port
or required CORS configuration. Having two supervised processes is compatible
with that single-origin contract; requiring two public services is not.

Normal HTML document requests go to the frontend SSR host. Protocol-marked
requests are forwarded through the host's Flux transport boundary. The generic
server helper illustrates the latter, not a replacement document router:

```ts
import { createFluxTransportProxy } from "@fluxfast/core/server";

export function createProtocolHandler(backendUrl: string) {
  const proxy = createFluxTransportProxy({ backendUrl });
  return (request: Request, encodedBackendPath: string) =>
    proxy(request, encodedBackendPath);
}
```

The host supplies an encoded origin-relative backend pathname without a query
or fragment; the incoming request retains its original query, method, body,
headers, and abort signal. The proxy requires `X-FluxFast: 1`, sanitizes per-hop
headers in both directions, preserves end-to-end authentication/CSRF and
separate `Set-Cookie` values, does not follow redirects, and returns an
unbuffered response stream. Return that response directly; calling `json()` or
`text()` to rebuild an SSE response breaks the contract. Missing protocol
markers fail closed, and upstream errors must not expose private addresses or
credentials. Hosts with dynamically assigned private ports must resolve the
trusted address at the appropriate request boundary rather than bake a stale
build-time address into the handler.

A production-capable integration must also preserve:

- **Immutable build/start separation:** generate/check and build beforehand;
  startup must not regenerate artifacts, modify source, install packages, or
  silently rebuild a missing artifact.
- **Supervised foreground lifetime:** backend readiness before accepting
  frontend traffic, bounded startup, failure of either child stops its sibling,
  and SIGTERM/SIGINT stop owned process groups within a shared shutdown deadline.
  Graceful shutdown releases both listeners; forced cleanup is not proof of a
  passing graceful-stop contract.
- **Private configuration:** backend address and application secrets remain
  server-only. Bind the backend privately, and expose only the frontend listener
  in the supported topology.
- **Public readiness/health:** probe through the frontend-to-backend boundary;
  keep responses non-cacheable and minimal (`/fluxfast/healthz` and
  `/fluxfast/readyz`), without process/port/path/Redis/credential details.
- **Streaming:** preserve cancellation and incremental SSE through host and
  reverse proxy boundaries; do not buffer, cache, or transform away live delivery.
- **Worker coherence:** Redis live publication for multiple workers/instances;
  Redis resource caching for positive-TTL shared live state, or explicitly
  process-local caching with `ttl=0`. Do not silently substitute local state for
  failed distributed dependencies.
- **Production diagnostics exclusion:** no DevTools UI, timeline serialization,
  SSR diagnostic bootstrap, or diagnostic opt-in generated by the adapter.
  A forged request header cannot enable a production backend trace.

Phase A does **not** add React production detection or a new process abstraction.
The implemented `fluxfast dev/build/start/doctor` integration still supports
Next.js. A future host must implement and verify this lifecycle explicitly;
this document alone does not make it supported. See [production](production.md)
and [containers](containers.md) for current commands and operational boundaries.

## Development diagnostics

An adapter must preserve Core's public value-free diagnostic channel for SSR,
navigation, resources, caches, mutations, deferred work, and live activity.
Diagnostic subscriptions must follow their owning lifetimes, and consumer-owned
timelines must remain bounded and development-only. They are not synchronization
authority and cannot become a requirement for normal application behavior.

Initial server traces are explicitly opted into only in a trusted development
environment, validated through Core, and passed as separate development
metadata. Bootstrap the SSR trace and hydration marker once with correlation
preserved. Do not log or serialize resource/patch values, cookies, auth headers,
query parameters, scope fingerprints, mutation bodies, raw exceptions, or
private addresses. Malformed diagnostic metadata must not prevent the page
from rendering. DevTools UI binding is adapter-specific; the shared diagnostic
contract does not require a framework-independent copy of the Next Debugbar.
See [DevTools](devtools.md) and [Core diagnostics](core-api.md#observe-development-diagnostics).

## Conformance and acceptance

The [shared suite](../tests/adapter-conformance/README.md) defines adapter
behavior through real HTTP, browser interactions, and public FluxFast APIs.
Framework-specific startup, compilation, request mapping, and fixture UI belong
in a harness; shared expectations must not branch on a framework's private
stores or weaken behavior for a second adapter.

| Required behavior | Current shared contract evidence |
| --- | --- |
| Meaningful SSR, route/query/auth forwarding, identical hydration, no duplicate blocking load, real 404, safe canonical/external SSR redirects | [`ssr-hydration.spec.ts`](../tests/adapter-conformance/contract/ssr-hydration.spec.ts) and [`critical-flow.spec.ts`](../tests/adapter-conformance/contract/critical-flow.spec.ts) |
| Link/visit navigation, push/replace, Back/Forward, scroll, known-version deltas, prefetch, page/resource LRU, selective refresh and retry | [`navigation-resources.spec.ts`](../tests/adapter-conformance/contract/navigation-resources.spec.ts) and `critical-flow.spec.ts` |
| All five mutation patches, authoritative validation, stale invalidation, internal/external mutation redirects | [`mutation-patches.spec.ts`](../tests/adapter-conformance/contract/mutation-patches.spec.ts) and `critical-flow.spec.ts` |
| Pending manifests, single follow-up, errors/retry, history restoration, ignored abort/late results | [`deferred-authority.spec.ts`](../tests/adapter-conformance/contract/deferred-authority.spec.ts) and [`deferred-flow.spec.ts`](../tests/adapter-conformance/contract/deferred-flow.spec.ts) |
| One initial live stream/deferred batch, effect restart lifecycle, scoped signals, origin suppression, offline resync, patches, navigation/Back | [`hydration-live.spec.ts`](../tests/adapter-conformance/contract/hydration-live.spec.ts) and [`live-flow.spec.ts`](../tests/adapter-conformance/contract/live-flow.spec.ts) |
| Value-free correlated development observations | [`diagnostics.spec.ts`](../tests/adapter-conformance/contract/diagnostics.spec.ts) |
| Production exclusions, fail-closed non-Flux documents, public health, one-origin live behavior | [`production.spec.ts`](../tests/adapter-conformance/contract/production.spec.ts), `live-flow.spec.ts`, and the process harness |

The test-only `FluxAdapterTestHarness` supplies `name`, `baseUrl`, `start()`,
`stop()`, and optional `build()`. Its browser probe is a test facade over public
Core APIs, **not** a production adapter export requirement. A future harness must
supply equivalent authoritative backend scenarios and fixture UI, run the same
expectations, and expose equivalent test observations without private-framework
assertions.

Run from the repository root after the [suite's setup](../tests/adapter-conformance/README.md#run-locally):

```sh
pnpm test:adapter-conformance
pnpm test:adapter-conformance:production
```

Both modes are required: development diagnostic assertions and production-only
deployment assertions execute in their own mode. Their opposite-mode skips are
not a waiver. Next is the current registered harness; these commands do not
imply another adapter exists. Production also verifies unchanged frontend
inputs and graceful process cleanup.

Passing the browser suite is necessary, not sufficient. Core/package regressions
prove additional authority, protocol bounds, and cancellation behavior;
distributed, container, security, bundle, benchmark, packed-consumer, and actual
published mixed-version gates remain applicable. An adapter must not claim
compatibility from a narrow render-only test. See [CONTRIBUTING](../CONTRIBUTING.md)
for verification selection and [versioning](versioning.md) for the public
compatibility boundary.
