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

## Browser caches

`ResourceStore` has a configurable LRU bound (128 by default in the Next
adapter). Values remain until replacement, invalidation, clear, or eviction.
Browser lifetime is not server TTL: every navigation still coordinates opaque
versions with the server.

`PageCache` holds lightweight page descriptors and version maps. It never owns
resource values. Prefetch entries are rejected if their prerequisite versions
have been evicted, invalidated, or replaced.

Call `router.clear()` on logout. It clears resource, page, and prefetch state so
authenticated values cannot survive a session transition.
