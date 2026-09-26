# Advanced Stable APIs

Advanced Stable APIs are supported public APIs for infrastructure, framework,
transport, protocol, cache, live-resource, validation-plan, and generation
integrations. They receive the same FluxFast 1.x compatibility guarantee as
Stable APIs. "Advanced" means lower-level and easier to misuse; it does not
mean experimental.

Most application pages and components do not need these APIs. Start with the
[Stable APIs guide](stable-apis.md) if your goal is to define pages, load
resources, render data, navigate, or submit a form.

## When an Advanced Stable API is appropriate

Use this surface when at least one of these statements is true:

- you operate multiple FastAPI workers and need a distributed resource cache
  or live-event broker;
- you are integrating FluxFast with a nonstandard framework, native shell, or
  test transport;
- you must install or customize the server-only Next.js transport and health
  route handlers instead of using generated defaults;
- you are building code generation or validation tooling that consumes the
  documented plan/schema contracts;
- you are observing live/cache runtime metrics or handling their documented
  operational failures; or
- you are implementing protocol-compatible software and therefore need the
  frozen envelope, event, capability, and header contracts.

Do not choose an Advanced Stable API merely to avoid a higher-level helper.
The high-level API normally owns safety checks, lifecycle cleanup, request
headers, reconnect behavior, and generated-type integration that custom code
must otherwise reproduce.

## Advanced API families

### Python infrastructure and protocol

| Family | Representative APIs | Use it when... |
| --- | --- | --- |
| Resource cache backends | `ResourceCacheBackend`, `MemoryResourceCache`, `RedisResourceCache`, `CachedResource` | You are selecting or implementing where canonical resource values and tag indexes are cached. |
| Live brokers | `LiveBroker`, `MemoryLiveBroker`, `RedisLiveBroker`, `LiveCoordinator` | You are coordinating live invalidations and patches within or across workers. |
| Metrics | `LiveMetrics`, `RedisCacheMetrics` and their snapshots | You are exporting bounded operational counters to your monitoring system. |
| Protocol models | `PageEnvelope`, `MutationEnvelope`, `ErrorEnvelope`, resource and event models | You are implementing or testing a protocol boundary, not ordinary page code. |
| Capability and header constants | `CAPABILITY_*`, `HEADER_CAPABILITIES`, `PROTOCOL_VERSION`, `PROTOCOL_MEDIA_TYPE` | You are negotiating a compatible client/server feature or writing an adapter. |
| Live stream primitives | `derive_live_topic`, `encode_sse_event`, `iter_live_events`, `LiveSubscription` | You are implementing authorized live delivery below `FluxFast`. |
| Standalone router | `FluxRouter` | You need the FluxFast FastAPI router without the normal application integrator. |

### Core transport, live, and validation internals

| Family | Representative APIs | Use it when... |
| --- | --- | --- |
| Transport | `FluxTransport`, `FetchTransport`, `VisitTransportRequest`, `MutationTransportRequest` | A nonstandard host must provide page visits and mutations without the built-in Fetch transport. |
| Protocol assertions | `PageEnvelope`, `MutationEnvelope`, `assertPageEnvelope`, `assertMutationEnvelope` | An adapter receives unknown wire data and must reject incompatible payloads. |
| Live client integration | `LiveTransport`, `LiveManager`, `FetchSseLiveTransport`, live event types | A host must replace the browser SSE implementation or own live connection lifecycle. |
| Capability serialization | `FluxCapability`, `FLUX_CAPABILITIES`, capability helpers | An adapter constructs bounded negotiation headers. |
| Validation plans | `ValidationPlanDocument`, `CompiledValidationPlan`, node-plan types and limits | A generator or validator bridge produces or consumes FluxFast validation plans. |
| Runtime caches and history | `PageCache`, `PrefetchManager`, `HistoryManager` | An adapter replaces browser/runtime coordination rather than merely using hooks. |

### Next.js server and tooling integration

| Family | APIs | Use it when... |
| --- | --- | --- |
| Server transport route | `createFluxTransportHandler`, `FluxTransportHandlerOptions` | You manually own the private-backend proxy route or inject a test fetch implementation. |
| Health route | `createFluxHealthHandler`, `FluxHealthHandlerOptions` | You manually own same-origin health/readiness forwarding or need a deliberate timeout. |
| Route context | `FluxTransportRouteContext` | You are adapting a nonstandard route wrapper to the transport handler. |
| Registry inspection | `createPagesRegistrySnapshot`, `PagesRegistrySnapshot` | Tooling needs a read-only in-memory registry snapshot without writing files. |
| Destination resolution | `buildFluxPath`, `resolveInternalDestination` | Server tooling reconstructs a safe backend path or private rewrite destination. |
| Client context | `FluxContext`, `FluxContextValue` | A framework wrapper must bridge the provider context directly. Components should use hooks. |

## Example: multi-worker Redis cache and live broker

The default memory cache and broker are process-local. A deployment with
multiple workers uses the Advanced Stable Redis implementations so every
worker sees the same cached values and live signals.

Install the optional dependency:

```bash
python -m pip install "fluxfast[redis]"
```

Configure both components once per FastAPI process:

```python
import os

from fastapi import FastAPI
from fluxfast import FluxFast, RedisLiveBroker, RedisResourceCache


redis_url = os.environ["REDIS_URL"]
namespace = os.environ.get("FLUXFAST_NAMESPACE", "hotel-production")

cache = RedisResourceCache.from_url(
    redis_url,
    namespace=namespace,
)
broker = RedisLiveBroker.from_url(
    redis_url,
    channel_prefix=f"fluxfast:{namespace}:live:",
)

app = FastAPI()
flux = FluxFast(app, cache=cache, broker=broker)
```

Configuration input:

```dotenv
REDIS_URL=redis://redis.internal:6379/0
FLUXFAST_NAMESPACE=hotel-production
```

Once Redis is reachable and the application lifespan has started, the backend
readiness endpoint returns:

```http
HTTP/1.1 200 OK
Content-Type: application/json

{"status":"ready"}
```

Every worker in one deployment must use the same Redis database, cache
`namespace`, and broker `channel_prefix`. Different applications,
environments, or incompatible rollouts need different values. These names
provide operational isolation, not authorization; Redis credentials and
network policy remain infrastructure responsibilities.

Use both components when you need shared positive-TTL live resources. The
cache stores canonical values; the broker carries ephemeral events. Neither
replaces the other or the primary database. See
[Distributed Resource Coherence](distributed-cache.md) for failure behavior,
limits, and topology choices.

## Example: manually own the Next.js server handlers

`fluxfast init` normally generates these routes. Use the Advanced Stable
handlers directly only when your application deliberately owns the files or
needs explicit server-only options.

Transport route at
`src/app/_fluxfast/transport/[[...path]]/route.ts`:

```ts
import { createFluxTransportHandler } from "@fluxfast/next/server";

export const dynamic = "force-dynamic";

const transport = createFluxTransportHandler({
  backendUrl: process.env.FLUXFAST_BACKEND_URL,
});

export const GET = transport;
export const HEAD = transport;
export const POST = transport;
export const PUT = transport;
export const PATCH = transport;
export const DELETE = transport;
```

Health route at `src/app/_fluxfast/[probe]/route.ts`:

```ts
import { createFluxHealthHandler } from "@fluxfast/next/server";

export const dynamic = "force-dynamic";

export const GET = createFluxHealthHandler({
  backendUrl: process.env.FLUXFAST_BACKEND_URL,
  timeoutMs: 2_000,
});
```

Input:

```http
GET /_fluxfast/readyz HTTP/1.1
Host: app.example.com
```

Successful output:

```http
HTTP/1.1 200 OK
Cache-Control: no-store
Content-Type: application/json; charset=utf-8

{"status":"ready"}
```

If the private backend is unavailable, times out, or returns a malformed
payload, the public handler returns the bounded non-sensitive response:

```http
HTTP/1.1 503 Service Unavailable
Cache-Control: no-store
Content-Type: application/json; charset=utf-8

{"status":"not_ready"}
```

The transport handler accepts only requests carrying FluxFast's private
transport marker, removes hop-by-hop headers, keeps response bodies streaming,
and does not expose the backend URL to browser code. A custom wrapper must
preserve those properties.

## Example: provide a framework-neutral Core transport

Adapter authors can replace browser Fetch by implementing `FluxTransport`.
This small in-memory transport is useful for a non-browser host or deterministic
adapter test:

```ts
import {
  createFluxRuntime,
  type FluxTransport,
} from "@fluxfast/core";

const transport: FluxTransport = {
  async visit(request) {
    return {
      protocol: "fluxfast/1",
      page: {
        component: "reports/index",
        url: request.url,
      },
      resources: {
        summary: {
          version: "summary-v1",
          value: { total: 12 },
        },
      },
    };
  },

  async mutate() {
    return {
      protocol: "fluxfast/1",
      mutation: { invalidate: ["summary"] },
    };
  },
};

const runtime = createFluxRuntime({
  transport,
  deferHistory: true,
});

await runtime.visit("/reports", { preserveState: true });

console.log({
  page: runtime.pageStore.getSnapshot(),
  summary: runtime.resourceStore.getSnapshot("summary"),
});
```

Output:

```json
{
  "page": {
    "component": "reports/index",
    "url": "/reports",
    "meta": {}
  },
  "summary": {
    "total": 12
  }
}
```

A production transport must also propagate abort signals, return structured
mutation errors, enforce protocol compatibility, preserve safe redirect
semantics, and avoid applying stale responses. Prefer `FetchTransport` unless
the host genuinely cannot use it.

## Example: inspect protocol data safely

Protocol models and assertions are appropriate at trust boundaries. Validate
unknown JSON before an adapter treats it as a page envelope:

```ts
import {
  assertPageEnvelope,
  type PageEnvelope,
} from "@fluxfast/core";

export function readPageEnvelope(input: unknown): PageEnvelope {
  assertPageEnvelope(input);
  return input;
}
```

Valid input:

```json
{
  "protocol": "fluxfast/1",
  "page": { "component": "home/index", "url": "/" },
  "resources": {}
}
```

An incompatible protocol identifier throws `VersionMismatchError`; a malformed
page or resource record throws `ProtocolError`. Application components should
not parse these envelopes themselves—the adapter already validates them.

## Responsibilities that move to custom integrations

When you use Advanced Stable APIs, your integration owns more than the call
signature:

- **Lifecycle:** close owned Redis clients, abort superseded requests, stop
  subscriptions, and release listeners during shutdown or logout.
- **Security:** preserve FastAPI authorization, scope isolation, bounded
  headers/payloads, non-sensitive errors, and the one-origin browser model.
- **Correctness:** validate protocol data, ignore or reject unsupported
  capabilities safely, and prevent older responses from overwriting newer
  state.
- **Operations:** expose readiness honestly; never hide a distributed-cache
  failure behind an incoherent process-local fallback.
- **Compatibility:** import only official entry points and test against packed
  published packages rather than source or `dist` deep imports.

## APIs normal application code should usually avoid

| Instead of... | Normally use... |
| --- | --- |
| Constructing `PageEnvelope` in a React component | `usePage()` and `useResource()` |
| Building FluxFast request headers manually | `@fluxfast/next` navigation and mutation APIs |
| Reading `FluxContext` directly | `useFlux()`, `useRouter()`, and resource hooks |
| Creating transport and health handlers by hand | `fluxfast init` |
| Constructing validation-plan nodes | Generated validators or `createValidator()` |
| Calling live topic/SSE helpers in a page route | `resource(..., live=True)` and scoped invalidation |
| Using `MemoryResourceCache` as a distributed cache | `RedisResourceCache` or a deliberate custom backend |

## Complete inventories and specifications

- [Python public API](python-api.md#export-classification)
- [`@fluxfast/core` public API](core-api.md#classification)
- [`@fluxfast/next` public API](next-api.md#classification)
- [Wire protocol](protocol.md)
- [Distributed cache](distributed-cache.md)
- [Live deployment](live-deployment.md)
- [Validation plans and client validation](validation.md)
- [Stability contract](stability.md)
