# Caching and Isolation

FluxFast has distinct server resource, browser resource, and browser page
caches.

## Server resource cache

### v0.9 stability contract

Resource identity and mutation/cache semantics are 1.0 stable candidates:

- The logical key names application data. Reuse also depends on the explicit
  server-owned scope; a matching key alone does not authorize sharing.
- Versions are opaque equality tokens, not timestamps or ordered counters.
  Equal authoritative serialized values may reuse a version. Clients must not
  interpret the digest algorithm or reject a replacement because its version
  sorts before the previous token.
- A known-version response may omit unchanged values. Omission is not deletion;
  the browser retains its known value. Page manifests separately describe which
  resources belong to a page.
- TTL is the maximum permitted cache-reuse interval, not a promise that an entry
  remains resident or a schedule for background refresh. Invalidation removes
  the authoritative cached entry; the next read executes and caches the loader.
- Mutation patches and invalidations are distinct. A patch changes client state,
  not server cache. A plain string invalidation targets client state; use
  `invalidate_resource(key, scope=...)` to delete the corresponding server entry.
- Public, user, tenant, and custom scopes allow explicit reuse; request scope
  (including an omitted scope) never enables cross-request reuse. Positive TTL
  alone does not make a resource shareable.
- `defer` controls when a capable client may request a resource; `live` declares
  synchronization after hydration. Neither changes the logical key or removes
  scope requirements. Their lifecycle details are documented below.

These guarantees do not turn process-local caches into distributed caches.
Logout and anonymous/authenticated transitions must clear browser state; user
and tenant boundaries must remain explicit in the authoritative application.

`MemoryResourceCache` is async-safe, monotonic-clock TTL aware, tag indexed,
bounded to 10,000 entries by default, and LRU evicted. It is per process.

`RedisResourceCache` implements the same backend contract with shared values,
Redis-native TTL, atomic tag indexes, and explicit namespace isolation across
workers or hosts. Install it with `pip install "fluxfast[redis]"` and pass it
to `FluxFast(app, cache=...)`. See [distributed resource
coherence](distributed-cache.md) for configuration and operations.

Every reusable resource needs an explicit scope:

```python
scope.public()
scope.user(user.id)
scope.tenant(hotel.id)
scope.custom("organization", organization.id)
```

The internal key is `{scope fingerprint}::{logical resource key}`. A resource
without an explicit scope remains request-scoped even if a positive TTL is
provided. This prevents an omitted scope from silently turning personalized
data into public cache data. The Redis backend hashes this complete logical
identity before constructing its physical key; scope values are not exposed in
Redis key names.

`ttl=0` disables server reuse. Cache eviction or misses only cause the loader
to run again; they cannot change results.

Mutation code must invalidate every affected scoped cache entry. A client patch
does not by itself update the authoritative server cache:

```python
return mutation(
    patches={"rooms": [replace_item(room.id, serialize(room))]},
    invalidates=[
        invalidate_resource("rooms", scope=scope.tenant(hotel.id)),
        invalidate_resource("summary", scope=scope.tenant(hotel.id)),
    ],
)
```

Resource `tags=[...]` can group server entries for backend-level invalidation.
Tag invalidation does not identify live resource keys to browsers, so publish
the corresponding scoped resource invalidations separately when active clients
must refresh.

## Deferred resource cache behavior

`defer=True` changes when a cache miss loader runs; it does not bypass the
server cache:

1. The initial capable request probes the normal scoped cache.
2. A valid hit is returned immediately. If `X-FluxFast-Known` already names the
   same version, it is omitted and is not marked pending.
3. A miss is added to the envelope's `deferred` list without executing the
   loader.
4. The browser's later `X-FluxFast-Only` request executes the loader, stores a
   scoped result when `ttl > 0`, and applies normal known-version omission.

An uncacheable `ttl=0` deferred resource is pending on every capable full page
request and loads during every necessary follow-up. A positive TTL still does
nothing across requests unless the resource has an explicit cacheable scope.
Never use a public scope for user or tenant data merely to make deferral faster.

With `MemoryResourceCache`, one worker may miss a value cached by another; the
scoped loader must produce the same authorized result. With
`RedisResourceCache`, a deferred follow-up can populate Redis and a different
worker can reuse that value. Deferral must not rely on worker affinity in
either topology.

## Live invalidation and canonical refresh

Live synchronization preserves the same cache boundary:

```text
scoped mutation or manual invalidation
          ↓
delete the matching server resource-cache entry
          ↓
publish an opaque scoped live signal
          ↓
browser keeps its current value visible and marks it stale
          ↓
resource-only request reruns the authoritative FastAPI page
          ↓
loader produces and caches the canonical replacement
```

Deletion must happen before publication. Otherwise a connected browser can
react immediately and receive the old cached value. Both automatic scoped
mutation invalidations and `flux.live.invalidate()` follow this order.
`flux.live.patch()` also deletes first: the patch is an optimistic rendering
hint and the subsequent canonical refresh must not settle from stale cache.

Live resources require an explicit reusable scope even when `ttl=0`. Scope is
not only a cache-reuse decision; it is also the server-owned isolation identity
used to derive an opaque broker topic. Request scope is therefore invalid for
`live=True`. Browser requests never contain that scope or the internal cache
key.

A browser excludes stale versions from `X-FluxFast-Known`, coalesces nearby
events, and requests only active invalidated keys. Duplicate events can cause
another safe refresh but cannot make an older response authoritative because
each key has a generation. Inactive keys are invalidated locally and load when
a future page declares them again.

### Multiple workers

`MemoryResourceCache` and `MemoryLiveBroker` are separate process-local
components. Process-local resource caching remains correct with multiple
workers because a miss simply reruns the scoped loader. Process-local live
publication does not reach streams attached to another worker, so production
with more than one FastAPI process must configure `RedisLiveBroker` in every
worker.

Redis Pub/Sub shares only invalidation/patch signals; it does not store resource
values. If workers retain `MemoryResourceCache`, the worker handling a mutation
deletes only its local entry and a different worker can retain an older
positive-TTL entry. In that topology, live resources must use `ttl=0`.

`RedisResourceCache` supplies the other topology: all workers sharing its
explicit namespace read and delete the same entries. Pair it with
`RedisLiveBroker` to support positive-TTL live resources across workers:

```python
namespace = "hotel-prod"
cache = RedisResourceCache.from_url(REDIS_URL, namespace=namespace)
broker = RedisLiveBroker.from_url(
    REDIS_URL,
    channel_prefix=f"fluxfast:{namespace}:live:",
)
flux = FluxFast(app, cache=cache, broker=broker)
```

The cache is strict: Redis command, connection, and serialization failures are
public cache errors and never trigger an implicit process-local fallback.
Simultaneous cold misses may execute duplicate loaders, but ordinary warm hits
reuse one shared value regardless of worker count.

Broker messages are ephemeral. Redis interruption causes streams to reconnect
and reload all active live resources rather than replaying an event history.
Business mutation success is isolated from publication failure after canonical
cache invalidation. If shared cache invalidation itself fails, the live signal
is not published because other workers could otherwise refresh stale state.

## Browser caches

`ResourceStore` has a configurable LRU bound (128 by default in the Next
adapter). Values remain until replacement, invalidation, clear, or eviction.
Browser lifetime is not server TTL: every navigation still coordinates opaque
versions with the server.

`PageCache` holds lightweight page descriptors, each page's complete
`resourceKeys` manifest, resolved version maps, and pending deferred keys. It
never owns resource values. A resource-only success or error settles the
corresponding manifest entry. Back/Forward can reuse valid resolved values or
restore pending keys and restart their batch. A missing, stale, evicted, or
version-mismatched resolved value invalidates the cached page rather than
rendering an incoherent shell.

Completed and in-flight prefetch sets are independently capped at 32 entries.
Oldest in-flight work is aborted when the cap is exceeded, and `router.clear()`
aborts all remaining prefetch requests. Entries are rejected if their
prerequisite or returned resource versions have been evicted, invalidated, or
replaced. A response that loses a per-resource race cannot overwrite the newer
record. Prefetch may return a deferred cache hit, but it does not execute a
deferred loader on a cache miss; the real visit schedules that pending work.

Call `router.clear()` on logout. It closes the live stream, aborts pending visit,
deferred, and prefetch transport work, and clears resource, page, and prefetch
state. Lifecycle generations prevent a late mutation from patching or
redirecting the next authenticated session.
