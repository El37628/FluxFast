# ADR-0005: Use Redis for distributed resource coherence

Status: accepted.

## Context

FluxFast resource cache entries are independently versioned and scoped, but the
default `MemoryResourceCache` belongs to one Python process. Multiple FastAPI
workers can already share Live Resource signals through `RedisLiveBroker`; they
cannot safely reuse a positive-TTL cached value unless the application supplies
its own distributed `ResourceCacheBackend`.

This mismatch can break convergence. A worker may publish a live invalidation
while another worker continues serving a stale process-local entry. Silently
falling back to local memory when a configured shared cache is unavailable has
the same failure mode.

## Decision

FluxFast 0.5 adds `RedisResourceCache` as the first built-in distributed
implementation of the existing `ResourceCacheBackend`. Distribution remains a
backend concern: `ResourceEngine`, resource declarations, the `fluxfast/1`
browser protocol, and frontend packages do not gain Redis-specific behavior or
capabilities.

Every cache instance requires an explicit, validated application namespace.
Namespace delimiters are percent-encoded before constructing Redis keys, so a
namespace such as `hotel` cannot overlap `hotel:blue` during a bounded `SCAN`.
Logical cache identities and tags are hashed before they become Redis keys, so
scope fingerprints and application identifiers are not exposed in key names.
The internal key space is versioned independently from the browser protocol:

```text
fluxfast:cache:v1:<namespace>:resource:<identity-digest>
fluxfast:cache:v1:<namespace>:resource-tags:<identity-digest>
fluxfast:cache:v1:<namespace>:tag:<tag-digest>
```

Resource values use bounded, compact UTF-8 JSON with an explicit cache schema
version. Pickle and other executable serialization formats are forbidden.
Malformed JSON, invalid fields, and unknown schemas are removed when safe and
treated as cache misses. Cached values never include process-local monotonic
timestamps.

Redis native expiry defines TTL behavior. `ttl <= 0` deletes any prior entry
and does not store a replacement. On a hit, the backend reads the remaining
Redis TTL and constructs a compatible `CachedResource.expires_at` using the
current process's monotonic clock.

Tags use namespace-local Redis sorted sets whose members are complete resource
Redis keys and whose scores are absolute expiry times. A private per-resource
Redis set contains only its complete opaque tag-index keys, allowing overwrites
and deletes to remove prior memberships atomically without exposing tag values
in keys. Small atomic operations or pipelines keep resource values and tag
memberships coherent during set, overwrite, delete, and tag invalidation.
Expired memberships are pruned during normal operations. Competing valid writes
are last-writer-wins; v0.5 does not add a distributed loader lock.

`clear()` scans only the configured namespace in bounded batches and removes
matches with `UNLINK` where available. Runtime code must not use `KEYS`,
`FLUSHDB`, or `FLUSHALL`.

`RedisResourceCache.from_url()` owns and closes the Redis client it creates.
Direct client injection is non-owning by default. Closing is idempotent, and
FluxFast application shutdown closes an optional cache backend without
requiring custom backends to implement `close()`.

The cache is strict. Redis connection, command, serialization-size, and unsafe
write failures are exposed through public `ResourceCacheError`,
`ResourceCacheUnavailableError`, and `ResourceCacheSerializationError` types
with the original exception chained. No process-local fallback is attempted.
Malformed, oversized, or unknown-schema entries are safely logged without
identities or values, atomically removed with their tag memberships, and treated
as misses; a cleanup failure remains a strict availability error. Cache
invalidation must succeed before a corresponding live signal is published.

Backend operational metrics use bounded counters without resource keys, scope
fingerprints, tenant or user identifiers, namespaces, Redis URLs, or other
high-cardinality labels. Logs use `fluxfast.cache.redis`, never include cached
values or credentials, and avoid raw logical cache identities.

Applications using multiple workers should configure corresponding explicit
cache and live namespaces:

```python
namespace = "hotel-prod"

cache = RedisResourceCache.from_url(
    redis_url,
    namespace=namespace,
)
broker = RedisLiveBroker.from_url(
    redis_url,
    channel_prefix=f"fluxfast:{namespace}:live:",
)
```

The objects remain independently configured; FluxFast does not silently derive
one namespace from the other.

## Consequences

- A cached resource can be reused, expired, deleted, tag-invalidated, and
  cleared consistently through any worker sharing the namespace.
- `live=True` resources can use a positive TTL across workers when both the
  Redis resource cache and Redis live broker are configured.
- Namespace isolation, bounded payloads, safe decoding, failure recovery, and
  client ownership become release-blocking test contracts.
- Redis availability participates in application correctness. A cache outage
  is visible rather than silently weakening coherence.
- Warm-cache requests share values across workers, but simultaneous cold misses
  may still execute multiple loaders.
- Redis integration and browser tests must use real separate clients and
  processes; mocked command tests alone cannot establish distributed
  correctness.
- The first supported Redis version range will be documented only after the CI
  matrix proves it.

## Rejected alternatives

**Process-local fallback during Redis failure:** rejected because workers could
silently diverge and publish invalidations that do not remove stale values.

**Two-level memory and Redis caching:** rejected for v0.5 because an L1 cache
introduces another invalidation and coherence problem.

**Distributed loader locks:** deferred because duplicate cold-miss work affects
efficiency, not cache correctness.

**Memcached or a database-backed cache:** rejected as the first built-in
backend because Redis is already an optional FluxFast dependency and provides
native TTL, atomic operations, tag indexes, and the existing live signal path.

**NATS KV, Redis Streams, or cache invalidation messages without shared
values:** rejected because v0.5 needs one authoritative shared cache, not a new
event-log or messaging abstraction.

**Browser capabilities for distributed caching:** rejected because cache
topology is invisible to the browser protocol and frontend resource APIs.
