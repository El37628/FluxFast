# Live Resources

Live Resources keep an ordinary FluxFast resource synchronized after hydration.
They do not introduce another frontend store or a special live hook. Declare
`live=True` on the server and continue reading the value with `useResource()` or
`useDeferredResource()`:

```python
from fastapi import Depends
from fluxfast import Page, resource, scope


@flux.page("/dashboard")
async def dashboard(user=Depends(current_user)):
    return Page(
        component="dashboard/index",
        resources=[
            resource(
                "notifications",
                lambda: load_notifications(user.id),
                scope=scope.user(user.id),
                ttl=30,
                live=True,
            )
        ],
    )
```

```tsx
"use client";

import { useResource } from "@fluxfast/next";

export default function DashboardPage() {
  const notifications = useResource<Notification[]>("notifications");
  return <NotificationList items={notifications} />;
}
```

When another request invalidates that same scoped resource, connected clients
mark their current value stale, request only the resource from the canonical
FastAPI page, and render the fresh loader result. There is no polling, page
reload, duplicate endpoint, or custom browser event handler.

## How synchronization works

Live events are change signals, not authoritative data or a durable event log:

```text
mutation or manual publication
        ↓
server cache entry deleted
        ↓
scoped event published through MemoryLiveBroker or RedisLiveBroker
        ↓
fetch-based SSE stream receives invalidation
        ↓
ResourceStore keeps the current value visible and marks it stale
        ↓
X-FluxFast-Only request reruns the page and selected loader
        ↓
canonical value replaces the stale value
```

The browser opens at most one stream for the active page. Navigation changes
the authorized manifest and closes the obsolete stream. The Next provider does
not open a stream during SSR; it starts after hydration and safely tolerates
React Strict Mode setup and cleanup.

SSE is carried over `fetch()` rather than native `EventSource` because FluxFast
must send protocol, capability, resource-key, and client-identity headers. See
[ADR-0004](decisions/0004-live-resource-transport.md) for the decision.

## Scope is required

A live declaration must use an explicit reusable scope:

```python
scope.public()
scope.user(user.id)
scope.tenant(organization.id)
scope.custom("project", project.id)
```

Request scope is rejected for `live=True` because a future request could never
reconstruct the same subscription identity. Choose scope from authenticated,
server-side state. Never make personalized data public merely to enable live
synchronization.

The browser sends logical resource keys only. On every stream connection,
FastAPI reruns the page and its dependencies, intersects those keys with live
resources declared by the authoritative page, and derives opaque broker topics
from the server-owned scope. Connecting does not execute resource loaders, and
no raw scope, user ID, tenant ID, cache key, or broker topic is returned to the
browser.

## Automatic mutation synchronization

Return scoped invalidation descriptors from FluxFast mutations:

```python
from fluxfast import invalidate_resource, mutation, scope


@flux.mutation("/notifications/read")
async def mark_notifications_read(user=Depends(current_user)):
    await update_notifications(user.id)
    return mutation(
        invalidates=[
            invalidate_resource(
                "notifications",
                scope=scope.user(user.id),
            )
        ]
    )
```

FluxFast deletes the matching server cache entry and publishes an invalidation
to every connection authorized for the same scope. The originating router also
receives the normal mutation envelope and refreshes its active resource. Its
opaque `X-FluxFast-Client-ID` suppresses the echoed live event only in that tab,
preventing a duplicate refresh; other tabs and users in the same scope still
converge.

A string-only invalidation such as `invalidate=["notifications"]` tells the
originating browser what to refresh, but it has no reusable server scope and
therefore cannot broadcast or delete a scoped cache entry. Use
`invalidate_resource()` for cached or live resources.

## Manual invalidation and patches

Code outside a FluxFast mutation can publish through the application
coordinator:

```python
await flux.live.invalidate(
    "notifications",
    scope=scope.user(user.id),
)
```

Manual invalidation deletes the same scoped server cache entry before
publishing. This order prevents connected clients from immediately reloading a
stale cached value.

For a faster optimistic update, publish one or more existing patch operations:

```python
from fluxfast import replace_item

await flux.live.patch(
    "rooms",
    [replace_item(room.id, serialize_room(room))],
    scope=scope.tenant(hotel.id),
)
```

Live patches support `replace-resource`, `merge-object`, `replace-item`,
`remove-item`, and `append-item`. A receiving browser applies a valid patch
immediately, leaves the record stale, and then performs canonical revalidation.
If the resource is missing or a patch cannot apply, FluxFast skips the partial
update and reloads the resource instead. Patches are an acceleration, not a
replacement for a loader.

When publishing from request code that already has the originating client ID,
pass `origin_client_id` to suppress the echoed event in that client only. Do not
use user or tenant identities as client IDs.

### Publishing outside FastAPI

Background jobs and external ingestion processes can use the same public
coordinator without constructing a FastAPI application. Configure its Redis
cache namespace and broker channel prefix exactly like every web worker:

```python
from fluxfast import (
    LiveCoordinator,
    RedisLiveBroker,
    RedisResourceCache,
    scope,
)

namespace = "hotel-prod"
cache = RedisResourceCache.from_url(REDIS_URL, namespace=namespace)
broker = RedisLiveBroker.from_url(
    REDIS_URL,
    channel_prefix=f"fluxfast:{namespace}:live:",
)
publisher = LiveCoordinator(cache=cache, broker=broker)

try:
    await publisher.invalidate(
        "rooms",
        scope=scope.tenant(hotel.id),
    )
finally:
    await publisher.close()
    await cache.close()
```

`LiveCoordinator` is the supported resource publisher for Celery, RQ, ARQ,
scheduled tasks, and custom workers. Its `invalidate()` and `patch()` methods
delete canonical cache state before publishing the scoped signal, just as they
do inside `FluxFast`. Scope must come from trusted server-side identity. This
API remains resource-specific; FluxFast does not expose arbitrary event topics
or turn Redis Pub/Sub into a general message bus.

The coordinator closes its broker, while the independently supplied cache
retains its own lifecycle. Close both when the worker process owns both
objects. Long-running worker processes may instead construct them once at
startup and close them during worker shutdown.

## Deferred plus live

`defer=True` and `live=True` compose on one resource:

```python
resource(
    "activity",
    lambda: load_activity(organization.id),
    scope=scope.tenant(organization.id),
    ttl=10,
    defer=True,
    live=True,
)
```

```tsx
const activity = useDeferredResource<Activity[]>("activity");
```

The live stream can connect while the deferred loader is pending. A newer live,
mutation, retry, or navigation generation supersedes older work so late results
cannot overwrite current state. The usual pending, loading, error, retry, and
stale states remain available through `useDeferredResource()`.

## Connection status and reconnect

Most applications do not need connection UI. When they do, `useLiveStatus()`
returns `status`, `connected`, `reconnectAttempt`, and `lastEventAt`:

```tsx
import { useLiveStatus } from "@fluxfast/next";

const live = useLiveStatus();
return live.connected ? null : <p>Updates are reconnecting…</p>;
```

Status may be `idle`, `connecting`, `connected`, `reconnecting`, `offline`, or
`error`. Reconnect uses bounded exponential backoff with jitter. Once the new
stream is ready, FluxFast reloads every active live key because events may have
been missed. Duplicate events are also safe because canonical resource versions
and per-key generations decide which result may settle.

The server sends heartbeat comments every 15 seconds by default and normally
rotates a connection after 15 minutes so FastAPI dependencies reauthorize it.
Configure `live_heartbeat_interval` and `live_max_connection_age` on
`FluxFast(...)` when deployment timeouts require different values. Call
`router.clear()` during logout; it closes the stream and clears resource, page,
and prefetch state.

## Observability

The framework-neutral router extends its existing `router.on(...)` diagnostics
with:

```text
live:connect:start    live:connect:open     live:connect:close
live:connect:error    live:reconnect        live:event
live:invalidate       live:patch            live:resync
```

Payloads contain counts, reconnect attempts, safe reason enums, event types,
and the fixed `transport` error category. They deliberately omit URLs, logical
resource names, scopes, tenant/user identifiers, headers, and error messages.
These events are diagnostic only; resource synchronization does not depend on
listeners.

Each capable page response includes `X-FluxFast-Live-Resources` with the live
resource count. It never lists resource names.

Python exposes process-local counters through
`flux.live.metrics.snapshot().as_dict()` (also available as
`flux.live_metrics`). The snapshot contains:

```text
live_connections_active       live_connections_total
live_events_published         live_invalidations_published
live_patches_published        live_resyncs
live_queue_overflows          live_publish_errors
```

FluxFast intentionally does not select a monitoring vendor. Export this
snapshot through the application's existing Prometheus, OpenTelemetry, or
other metrics integration. Counts are process-local; aggregate them across
workers in the monitoring backend.

## Single-process and Redis brokers

`MemoryLiveBroker` is the default. It is suitable for local development, tests,
and a deployment with exactly one FastAPI process. It cannot carry an event
from one worker or host to a browser connected through another.

For multiple workers or hosts, install the optional dependency and configure
the same Redis deployment and channel prefix everywhere:

```bash
pip install "fluxfast[redis]"
```

```python
import os

from fastapi import FastAPI
from fluxfast import FluxFast, RedisLiveBroker

app = FastAPI()
broker = RedisLiveBroker.from_url(os.environ["REDIS_URL"])
flux = FluxFast(app, broker=broker)
```

Redis Pub/Sub is intentionally ephemeral. A broker interruption ends affected
streams; browser reconnect then performs canonical resynchronization. A
successful business mutation is not rolled back if publication fails: FluxFast
has already invalidated canonical cache state, logs the publication failure,
and lets later refresh/reconnect recover.

`RedisLiveBroker` distributes signals, not server cache entries. If multiple
workers use the built-in process-local `MemoryResourceCache`, declare live
resources with `ttl=0` so a canonical refresh cannot hit an old entry in another
worker. A positive TTL in that topology requires an application-provided shared
or cross-worker-invalidation-aware `ResourceCacheBackend`. A built-in Redis
resource cache is not part of v0.4.

## Backpressure and delivery guarantees

The in-memory broker defaults to 64 pending events per subscriber. A slow
subscriber never receives an unbounded queue: overflow coalesces queued keys
into a `resync` signal, or closes the stream if the bounded wire-key limit
cannot represent recovery. Redis messages are also size-limited.

FluxFast does not promise ordered durable replay, exactly-once delivery, or
`Last-Event-ID`. It promises convergence to the current canonical loader result
after invalidation, reconnect, resync, or uncertainty.

## Deployment and security checklist

- Keep the browser on the normal frontend origin; preserve FluxFast request
  headers through the Next rewrite and reverse proxy.
- Disable response buffering and caching for SSE, allow a read timeout longer
  than the heartbeat interval, and size file descriptors/connections for one
  stream per active live page and browser tab.
- Use Redis whenever more than one FastAPI worker/process can serve requests.
- With multiple workers, use `ttl=0` for live resources unless the configured
  resource cache is shared or invalidated across those workers.
- Authenticate and authorize in FastAPI dependencies on the page route.
- Use explicit user/tenant/custom scopes from server-owned identities.
- Clear the router on logout and keep the server's maximum connection age
  finite so long sessions are periodically reauthorized.

See [live deployment](live-deployment.md) for Nginx and Nginx Proxy Manager
examples, and [the protocol guide](protocol.md#live-resources) for the wire
contract.

## v0.4 limitations

Live Resources are one-way synchronization signals for existing resources.
They are not a general event bus, task queue, job runner, WebSocket API,
chat/presence primitive, durable log, or cross-tab shared connection. Each tab
has its own connection and client ID. Patches always revalidate, and custom
non-resource topics are not exposed. These constraints keep resource loaders,
FastAPI authorization, and the existing `ResourceStore` as the correctness
boundary.
