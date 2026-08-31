# Distributed Resource Coherence

FluxFast can keep independently scoped resource values coherent across
multiple FastAPI workers or hosts by using `RedisResourceCache`. It implements
the same `ResourceCacheBackend` contract as the default in-memory cache; the
browser protocol and frontend packages do not need to know which backend is in
use.

```text
FastAPI worker A ─┐
FastAPI worker B ─┼─→ RedisResourceCache ─→ shared values, TTLs, and tag indexes
FastAPI worker C ─┘
```

For live resources, configure `RedisLiveBroker` separately. The cache shares
canonical values and invalidations, while the broker carries ephemeral change
signals to streams attached to other workers:

```text
database mutation
      ↓
delete shared Redis cache entry
      ↓
publish scoped Redis live signal
      ↓
any worker performs canonical resource-only refresh
      ↓
loader result returns to Redis and the browser
```

## Choose the backend deliberately

| Topology | Resource cache | Live broker | Positive-TTL live resources |
| --- | --- | --- | --- |
| One FastAPI process | `MemoryResourceCache` | `MemoryLiveBroker` | Supported |
| Multiple processes, no live resources | `MemoryResourceCache` | Any | Correct, but values and loader work are not shared |
| Multiple processes with live resources | `MemoryResourceCache` | `RedisLiveBroker` | Use `ttl=0`; another worker may retain an old local entry |
| Multiple processes with shared values | `RedisResourceCache` | Any | Values and invalidations are shared |
| Multiple processes with positive-TTL live resources | `RedisResourceCache` | `RedisLiveBroker` | Supported and recommended |

`RedisLiveBroker` does not store resource values, and `RedisResourceCache`
does not deliver browser events. Configure both when the application needs
both guarantees. Sticky sessions do not replace either distributed component.

## Installation and configuration

Install the optional Redis client dependency:

```bash
pip install "fluxfast[redis]"
```

Create the cache and broker once per process and pass them to `FluxFast`:

```python
import os

from fastapi import FastAPI
from fluxfast import FluxFast, RedisLiveBroker, RedisResourceCache

redis_url = os.environ["REDIS_URL"]
namespace = "hotel-prod"

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

Every process that belongs to the same deployment must use the same Redis
database, cache `namespace`, and live `channel_prefix`. The two namespaces are
explicit and independent; FluxFast does not silently derive one from the
other. Different applications, environments, or incompatible deployments must
use different values, even if their logical resource names and tenant IDs are
the same.

The cache namespace accepts 1–128 ASCII letters, digits, periods, underscores,
colons, or hyphens. Delimiters are encoded in the physical key prefix, and
logical cache identities and tags are hashed. A namespace is operational
isolation, not authorization: use separate Redis credentials and network
controls where security boundaries require them.

### Supported Redis versions

FluxFast supports Redis Open Source 6.2 through 8.10. CI runs the real cache,
live, restart, and process-level integration suites against Redis 6.2.24 and
8.10.1, with Redis 7.4 used by the main distributed browser suite. Newer Redis
lines are not claimed until they join the compatibility matrix. Follow the
[Redis version lifecycle](https://redis.io/docs/latest/operate/oss_and_stack/install/version-mgmt/)
and use a supported patch release in production.

The Python optional dependency currently allows `redis-py` 5.x through 7.x.
That client version is separate from the Redis server version.

## Scopes, TTL, and loader behavior

Resource declarations do not change:

```python
resource(
    "rooms",
    load_rooms,
    scope=scope.tenant(hotel.id),
    ttl=60,
    tags=[f"hotel:{hotel.id}:inventory"],
)
```

An explicit reusable scope is still required for cross-request caching.
Request-scoped resources are never reused merely because Redis is configured.
Scope identities are folded into the logical cache identity before the backend
hashes it, preserving public, user, tenant, and custom isolation.

Redis owns expiry for distributed entries:

- `ttl > 0` is rounded up to Redis milliseconds and stored with native expiry;
- each hit reads the remaining Redis TTL and reconstructs a process-local
  monotonic `expires_at` value;
- `ttl <= 0` removes any prior entry and stores no replacement; and
- expired entries and tag memberships are pruned by Redis or normal cache
  operations.

A warm value written by worker A can be read by worker B without executing the
loader again. Simultaneous cold misses may still execute the loader in several
workers because v0.5 has no distributed lease or single-flight lock. Valid
competing writes are last-writer-wins. Loaders must therefore remain safe to
run more than once and must return the same authorized canonical state.

## Invalidation and tags

Scoped resource invalidation uses the same logical identity on every worker.
FluxFast mutations and `LiveCoordinator` delete that shared entry before
publishing a live signal. This ordering prevents a receiving browser from
immediately refreshing into an old cache hit.

Tags declared on resources are stored in namespace-local Redis sorted sets.
Invalidate a tag through the configured cache backend:

```python
await flux.cache.invalidate_tag(f"hotel:{hotel.id}:inventory")
```

Tag invalidation atomically removes every live matching resource and cleans its
other tag memberships. It affects server cache state only. If active live
browsers must refresh, also publish scoped resource invalidations for the
logical keys they are authorized to reload; FluxFast does not expose tag names
to browsers or treat tags as broadcast topics.

`await flux.cache.clear()` scans and unlinks only the exact configured
namespace in bounded batches. Runtime cache code never uses `KEYS`, `FLUSHDB`,
or `FLUSHALL`, so clearing one deployment cannot clear another correctly
namespaced deployment.

## Serialization and payload limits

Redis entries use compact UTF-8 JSON with an internal schema version. Pickle
and executable serialization formats are not used. Values must satisfy the
same JSON conversion rules as FluxFast responses. Cached data contains the
resource value, version, and tags, but never a process-local monotonic
timestamp.

The default `max_value_bytes` is 1 MiB for the complete encoded cache entry,
not only the source value. Set a different positive bound only from measured
workload evidence:

```python
cache = RedisResourceCache.from_url(
    redis_url,
    namespace="hotel-prod",
    max_value_bytes=256 * 1024,
)
```

An oversized or unserializable write raises
`ResourceCacheSerializationError`; FluxFast does not partially store it.
Malformed UTF-8/JSON, invalid fields, and unknown cache schemas found on read
are logged without the value or identity, removed with their tag membership,
and treated as recovered misses. If safe cleanup itself fails, the operation
remains an availability error.

## Failure semantics

The distributed cache is strict. Connection and Redis command failures raise
`ResourceCacheUnavailableError`; other invalid backend responses raise
`ResourceCacheError`. FluxFast never silently falls back to
`MemoryResourceCache`, because workers could diverge while appearing healthy.

This means Redis participates in application availability whenever it is the
configured cache:

- a failed cache read does not run a loader behind Redis's back;
- a failed write does not report a coherent cached result;
- a failed cache delete does not publish its corresponding live signal, while
  a failed tag invalidation remains visible to its caller; and
- a Redis restart may lose non-persistent entries, after which the next valid
  request safely repopulates them.

Cache errors include a low-cardinality `operation` detail such as `get`, `set`,
`delete`, `invalidate_tag`, or `clear`. Logs use `fluxfast.cache.redis` and omit
Redis URLs, credentials, resource keys, scope fingerprints, cached values, and
tenant/user identifiers. Decide at the application boundary whether an
operation should fail the request, be retried, or be handled by infrastructure;
do not introduce an incoherent local fallback.

## Metrics and operations

Each `RedisResourceCache` exposes process-local counters:

```python
snapshot = cache.metrics.snapshot()
metrics = snapshot.as_dict()
```

The snapshot contains:

```text
cache_gets                  cache_hits
cache_misses                cache_sets
cache_deletes               cache_tag_invalidations
cache_clears                cache_errors
cache_payload_bytes_written cache_payload_bytes_read
```

Counters intentionally have no high-cardinality labels. Export them through
the application's Prometheus, OpenTelemetry, or other metrics integration and
aggregate them across workers. Monitor hit rate, errors, encoded payload
volume, Redis latency/availability, memory, eviction policy, and connection
usage. FluxFast does not configure Redis persistence, eviction, TLS,
authentication, clustering, or backups for the application.

v0.5 has no Sentinel-specific abstraction or Redis Cluster-specific
optimization/guarantee. Validate provider and topology behavior in the
application's own deployment tests rather than inferring it from single-node
compatibility CI.

`RedisResourceCache.from_url()` owns the client it creates. `FluxFast` closes
that cache during FastAPI shutdown. Passing a Redis client directly is
non-owning by default, so the application remains responsible for that
client's lifecycle. Close a standalone cache explicitly when it is not owned
by `FluxFast`.

## Background publishers

Background jobs can use `LiveCoordinator` without a FastAPI application. They
must use the same cache namespace and broker prefix as the web workers:

```python
from fluxfast import LiveCoordinator, RedisLiveBroker, RedisResourceCache, scope

cache = RedisResourceCache.from_url(redis_url, namespace="hotel-prod")
broker = RedisLiveBroker.from_url(
    redis_url,
    channel_prefix="fluxfast:hotel-prod:live:",
)
publisher = LiveCoordinator(cache=cache, broker=broker)

try:
    await publisher.invalidate("rooms", scope=scope.tenant(hotel.id))
finally:
    await publisher.close()
    await cache.close()
```

Construct scopes only from trusted server-side identity. The coordinator is a
resource-specific publisher, not an arbitrary Redis Pub/Sub API or task queue.

## Production checklist

- Use a unique, explicit cache namespace per application/environment.
- Give all cooperating workers the same Redis database and namespace.
- Configure `RedisLiveBroker` too when live signals cross workers.
- Keep user and tenant scopes derived from authenticated server state.
- Size `max_value_bytes` and TTLs from measured workloads.
- Restrict Redis network access and credentials; use encrypted transport where
  the deployment boundary requires it.
- Use a supported Redis patch release and test provider-specific behavior.
- Monitor strict cache errors and never hide them with local-memory fallback.
- Keep loaders idempotent because simultaneous cold misses can duplicate work.
- Verify cross-worker warm hits, invalidation, restart recovery, and tenant
  isolation in the real deployment.

See [caching](caching.md) for the full server/browser cache model,
[Live Resources](live-resources.md) for synchronization semantics,
[live deployment](live-deployment.md) for proxy requirements, and
[ADR-0005](decisions/0005-distributed-resource-cache.md) for the architectural
decision.
