# Python public API

FluxFast 0.9 classifies every name exported from the official top-level
`fluxfast` package before the 1.0 API freeze. A stable candidate is the common
application-author surface. An advanced stable candidate is intended for
cache, live-resource, protocol, or framework integrations. Both categories are
supported public API and follow the same compatibility policy; "advanced" does
not mean experimental.

Deprecated names remain importable through 1.0 unless a security or protocol
correctness issue makes that impossible. FluxFast does not emit warnings merely
because the package is imported or an application starts. Names absent from
`fluxfast.__all__`, including underscore-prefixed implementation details and
undocumented deep-module imports, are internal unless another public contract
explicitly says otherwise.

## Export classification

This table is the authoritative Python export inventory. CI verifies that it
contains every `fluxfast.__all__` name exactly once.

<!-- python-api-export-table:start -->
| Symbol | 1.0 classification | Supported role |
| --- | --- | --- |
| `CAPABILITY_DEFERRED_RESOURCES` | Advanced Stable Candidate | Deferred-resource capability token. |
| `CAPABILITY_LIVE_RESOURCES` | Advanced Stable Candidate | Live-resource capability token. |
| `CacheScope` | Stable Candidate | Immutable cache-scope descriptor. |
| `CachedResource` | Advanced Stable Candidate | Cache-backend value contract. |
| `ContractMode` | Stable Candidate | General contract schema mode. |
| `DEFAULT_LIVE_HEARTBEAT_INTERVAL` | Advanced Stable Candidate | Default SSE heartbeat interval. |
| `DEFAULT_LIVE_MAX_CONNECTION_AGE` | Advanced Stable Candidate | Default live connection lifetime. |
| `DEFAULT_LIVE_QUEUE_SIZE` | Advanced Stable Candidate | Default in-memory broker queue bound. |
| `DEFAULT_REDIS_CHANNEL_PREFIX` | Advanced Stable Candidate | Default Redis live channel prefix. |
| `DEFAULT_REDIS_MAX_MESSAGE_BYTES` | Advanced Stable Candidate | Default Redis live-message bound. |
| `DEFAULT_REDIS_MAX_VALUE_BYTES` | Advanced Stable Candidate | Default Redis cache-value bound. |
| `DEFAULT_REDIS_SCAN_COUNT` | Advanced Stable Candidate | Default Redis cache scan batch size. |
| `ErrorDetail` | Advanced Stable Candidate | Protocol error payload model. |
| `ErrorEnvelope` | Advanced Stable Candidate | Protocol error envelope model. |
| `FluxFast` | Stable Candidate | FastAPI application integrator. |
| `FluxFastError` | Stable Candidate | Base FluxFast exception. |
| `FluxFastLiveScopeError` | Stable Candidate | Invalid live-resource scope error. |
| `FluxRouter` | Advanced Stable Candidate | Standalone FastAPI router integration. |
| `HEADER_CAPABILITIES` | Advanced Stable Candidate | Capability-negotiation header name. |
| `InvalidateResource` | Stable Candidate | Scoped invalidation descriptor. |
| `LIVE_EVENT_NAME` | Advanced Stable Candidate | SSE event name. |
| `LIVE_HEARTBEAT` | Advanced Stable Candidate | SSE heartbeat frame. |
| `LIVE_RESYNC_REASONS` | Advanced Stable Candidate | Supported live resynchronization reasons. |
| `LiveBroker` | Advanced Stable Candidate | Live fan-out protocol. |
| `LiveCoordinator` | Advanced Stable Candidate | Scoped live invalidation and patch coordinator. |
| `LiveEvent` | Advanced Stable Candidate | Discriminated live-event type. |
| `LiveInvalidateEvent` | Advanced Stable Candidate | Live invalidation event model. |
| `LiveMetrics` | Advanced Stable Candidate | Process-local live metrics collector. |
| `LiveMetricsSnapshot` | Advanced Stable Candidate | Immutable live metrics snapshot. |
| `LivePatchEvent` | Advanced Stable Candidate | Live patch event model. |
| `LiveReadyEvent` | Advanced Stable Candidate | Live stream ready event model. |
| `LiveResyncEvent` | Advanced Stable Candidate | Live resynchronization event model. |
| `LiveResyncReason` | Advanced Stable Candidate | Live resynchronization reason type. |
| `LiveSubscription` | Advanced Stable Candidate | Authorized live subscription descriptor. |
| `MemoryLiveBroker` | Advanced Stable Candidate | Single-process live broker. |
| `MemoryResourceCache` | Advanced Stable Candidate | Single-process resource cache. |
| `MutationEnvelope` | Advanced Stable Candidate | Protocol mutation envelope model. |
| `MutationPayload` | Advanced Stable Candidate | Protocol mutation payload model. |
| `MutationResult` | Stable Candidate | Server mutation result descriptor. |
| `PROTOCOL_MEDIA_TYPE` | Advanced Stable Candidate | FluxFast JSON media type. |
| `PROTOCOL_VERSION` | Advanced Stable Candidate | Browser wire-protocol identifier. |
| `Page` | Stable Candidate | Server-driven page descriptor. |
| `PageDescriptor` | Advanced Stable Candidate | Protocol page descriptor model. |
| `PageEnvelope` | Advanced Stable Candidate | Protocol page envelope model. |
| `PageNotFoundError` | Deprecated | Compatibility-only exception; FluxFast does not raise it. |
| `ProtocolError` | Advanced Stable Candidate | Wire-protocol constraint error. |
| `RedisCacheMetrics` | Advanced Stable Candidate | Redis cache metrics collector. |
| `RedisCacheMetricsSnapshot` | Advanced Stable Candidate | Immutable Redis cache metrics snapshot. |
| `RedisLiveBroker` | Advanced Stable Candidate | Multi-worker Redis live broker. |
| `RedisResourceCache` | Advanced Stable Candidate | Multi-worker Redis resource cache. |
| `ResourceCacheBackend` | Advanced Stable Candidate | Resource cache backend protocol. |
| `ResourceCacheError` | Advanced Stable Candidate | Base resource-cache failure. |
| `ResourceCacheSerializationError` | Advanced Stable Candidate | Cache serialization failure. |
| `ResourceCacheUnavailableError` | Advanced Stable Candidate | Cache availability failure. |
| `ResourceContract` | Stable Candidate | Typed logical resource contract. |
| `ResourceContractError` | Stable Candidate | Typed resource validation or serialization error. |
| `ResourceError` | Stable Candidate | Resource resolution error. |
| `ResourceErrorDetail` | Advanced Stable Candidate | Per-resource protocol error model. |
| `ResourceLoader` | Stable Candidate | Sync-or-async resource loader type. |
| `ResourceSpec` | Stable Candidate | Resource loading and caching descriptor. |
| `ResourceWireRecord` | Advanced Stable Candidate | Versioned protocol resource model. |
| `ScopeError` | Stable Candidate | Invalid cache-scope error. |
| `ScopeType` | Stable Candidate | Cache-scope kind enumeration. |
| `TypeContract` | Stable Candidate | General application type contract. |
| `ValidationError` | Deprecated | Compatibility-only exception; FluxFast does not raise it. |
| `append_item` | Stable Candidate | Append-item mutation patch builder. |
| `client_supports` | Advanced Stable Candidate | Request capability lookup helper. |
| `derive_live_topic` | Advanced Stable Candidate | Opaque scoped live-topic derivation. |
| `encode_sse_event` | Advanced Stable Candidate | Validated live-event SSE encoder. |
| `flux_external_redirect` | Stable Candidate | External browser redirect result builder. |
| `flux_redirect` | Stable Candidate | Internal navigation redirect result builder. |
| `invalidate_resource` | Stable Candidate | Scoped invalidation builder. |
| `iter_live_events` | Advanced Stable Candidate | Live SSE stream iterator. |
| `merge_object` | Stable Candidate | Merge-object mutation patch builder. |
| `mutation` | Stable Candidate | Mutation result builder. |
| `remove_item` | Stable Candidate | Remove-item mutation patch builder. |
| `replace_item` | Stable Candidate | Replace-item mutation patch builder. |
| `replace_resource` | Stable Candidate | Replace-resource mutation patch builder. |
| `resource` | Stable Candidate | Page resource builder. |
| `scope` | Stable Candidate | Cache-scope factory. |
<!-- python-api-export-table:end -->

## Signature decisions

The v0.8.1 call shapes are suitable for 1.0 and remain frozen in v0.9:

- `FluxFast` continues accepting the documented `broker=` argument and the
  existing `live_broker=` compatibility spelling. Passing both remains an
  error.
- `mutation()` continues accepting both `patch=`/`patches=` and
  `invalidate=`/`invalidates=`. Passing both forms of a pair remains an error.
- `resource()` continues accepting either a string key or a
  `ResourceContract`, and an omitted scope remains request-scoped even when a
  positive TTL is supplied.
- Redis cache and broker constructors continue requiring explicit isolation
  through `namespace=` and, where deployments share Redis, an intentionally
  selected `channel_prefix=`.

These compatibility spellings are frozen rather than reordered or removed:
the small aesthetic improvement would not justify migration work before 1.0.

## Deprecated exports

`ValidationError` and `PageNotFoundError` have been compatibility-only exports
since the first release and are not raised by the FluxFast runtime.

- For request validation, use FastAPI's validation lifecycle and consume the
  structured FluxFast error envelope. Catch `ResourceContractError` when a
  declared resource contract rejects a loader value.
- For missing routes, use FastAPI/Starlette's ordinary 404 handling or raise
  `fastapi.HTTPException(status_code=404)` in application code.

Existing imports keep working through 1.0. New applications should not depend
on either deprecated class.

## What this freeze does not cover

The Python export classification does not independently redefine the browser
wire protocol, protocol headers, capability negotiation, developer schema, or
generated files. Those contracts are versioned and frozen in their dedicated
v0.9 reviews. See [versioning and compatibility](versioning.md) and the
[wire protocol](protocol.md).
