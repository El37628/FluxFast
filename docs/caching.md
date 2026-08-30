# Caching and Isolation

FluxFast has distinct server resource, browser resource, and browser page
caches.

## Server resource cache

`MemoryResourceCache` is async-safe, monotonic-clock TTL aware, tag indexed,
bounded to 10,000 entries by default, and LRU evicted. It is per process.

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
data into public cache data.

`ttl=0` disables server reuse. Cache eviction or process-local misses only cause
the loader to run again; they cannot change results.

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

The in-memory cache remains process-local. In a multi-worker deployment, one
worker may miss a value cached by another; the scoped loader must produce the
same authorized result. Deferral must not rely on cache affinity for
correctness.

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

Redis Pub/Sub shares only invalidation/patch signals; it is not a distributed
resource cache. Each worker may still hold its own scoped resource entries. The
worker handling a mutation deletes its local entry before publishing, but a
different worker can retain an older positive-TTL entry. Therefore a
multi-worker live resource must use `ttl=0` with `MemoryResourceCache`, or the
application must provide a shared/cross-worker-invalidation-aware
`ResourceCacheBackend`. `RedisLiveBroker` does not turn `MemoryResourceCache`
into Redis storage, and a built-in Redis resource cache is outside v0.4.

Broker messages are ephemeral. Redis interruption causes streams to reconnect
and reload all active live resources rather than replaying an event history.
Business mutation success is isolated from publication failure after canonical
cache invalidation.

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

Prefetch entries are rejected if their prerequisite versions have been
evicted, invalidated, or replaced. Prefetch may return a deferred cache hit, but
it does not execute a deferred loader on a cache miss; the real visit schedules
that pending work.

Call `router.clear()` on logout. It closes the live stream and clears resource,
page, and prefetch state so authenticated values and subscriptions cannot
survive a session transition.
