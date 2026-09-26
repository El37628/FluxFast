# Python public API

FluxFast 1.x classifies every name exported from the official top-level
`fluxfast` package. A stable API is the common application-author surface. An
advanced stable API is intended for cache, live-resource, protocol, or framework
integrations. Both categories are supported public API and follow the same
compatibility policy; "advanced" does not mean experimental.

Deprecated names remain importable throughout 1.x unless a security or protocol
correctness issue makes that impossible. FluxFast does not emit warnings merely
because the package is imported or an application starts. Names absent from
`fluxfast.__all__`, including underscore-prefixed implementation details and
undocumented deep-module imports, are internal unless another public contract
explicitly says otherwise.

For task-based guidance, start with [Stable APIs](stable-apis.md). If you are
building cache, live-resource, protocol, or framework infrastructure, use the
[Advanced Stable APIs guide](advanced-stable-apis.md). This page remains the
authoritative symbol-by-symbol Python inventory.

## Common API inputs and outputs

The examples below show the public Python objects together with the wire values
they produce. The HTTP requests represent what the Next.js adapter sends; an
ordinary application does not need to construct these headers by hand.

### Define a typed page resource

`FluxFast`, `Page`, `resource()`, and `scope` form the usual page API. The
Pydantic model is both the server-side validation contract and the source for
generated frontend types.

```python
from typing import Literal

from fastapi import FastAPI
from fluxfast import FluxFast, Page, resource, scope
from pydantic import BaseModel


class Room(BaseModel):
    id: int
    status: Literal["available", "occupied"]


app = FastAPI()
flux = FluxFast(app)
ROOMS = flux.define_resource("rooms", list[Room])


@flux.page("/rooms", name="rooms")
async def rooms() -> Page:
    return Page(
        component="rooms/index",
        resources=[
            resource(
                ROOMS,
                lambda: [{"id": 101, "status": "available"}],
                scope=scope.public(),
                ttl=30,
            )
        ],
        meta={"title": "Rooms"},
    )
```

Input from the adapter:

```http
GET /rooms HTTP/1.1
X-FluxFast: 1
X-FluxFast-Protocol: 1
```

Output (`version` is an opaque content version and will change with the value):

```json
{
  "protocol": "fluxfast/1",
  "page": {
    "component": "rooms/index",
    "url": "/rooms",
    "meta": { "title": "Rooms" }
  },
  "resources": {
    "rooms": {
      "version": "73915f1c8af5463d44965405f18e6531",
      "value": [{ "id": 101, "status": "available" }]
    }
  }
}
```

The component identifier selects an allowlisted frontend module. It is not an
arbitrary import path. Use a reusable cache scope only when the value is safe to
share at that scope; authenticated or tenant data should use `scope.user(...)`
or `scope.tenant(...)` after normal FastAPI authorization.

### Return a mutation result

Mutation helpers describe the client update; the FastAPI handler still owns
authorization, validation, and the database transaction.

```python
from fluxfast import invalidate_resource, mutation, replace_item


class RoomUpdate(BaseModel):
    status: Literal["available", "occupied"]


@flux.mutation("/rooms/{room_id}", methods=["PATCH"], name="update_room")
async def update_room(room_id: int, body: RoomUpdate):
    # Persist the update before returning the mutation result.
    return mutation(
        patches={
            "rooms": [
                replace_item(
                    room_id,
                    {"id": room_id, "status": body.status},
                )
            ]
        },
        invalidates=[
            invalidate_resource("summary", scope=scope.public()),
        ],
    )
```

Input:

```http
PATCH /rooms/101 HTTP/1.1
Content-Type: application/json
X-FluxFast: 1

{"status":"occupied"}
```

Output:

```json
{
  "protocol": "fluxfast/1",
  "mutation": {
    "patches": {
      "rooms": [
        {
          "op": "replace-item",
          "id": 101,
          "value": { "id": 101, "status": "occupied" }
        }
      ]
    },
    "invalidate": ["summary"]
  }
}
```

The browser applies the room patch immediately. It treats `summary` as stale,
while the explicit public scope also lets the backend delete the matching cache
entry and publish a live invalidation when a shared broker is configured.

## Export classification

This table is the authoritative Python export inventory. CI verifies that it
contains every `fluxfast.__all__` name exactly once.

<!-- python-api-export-table:start -->
| Symbol | 1.x classification | Supported role |
| --- | --- | --- |
| `CAPABILITY_DEFERRED_RESOURCES` | Advanced Stable | Deferred-resource capability token. |
| `CAPABILITY_LIVE_RESOURCES` | Advanced Stable | Live-resource capability token. |
| `CacheScope` | Stable | Immutable cache-scope descriptor. |
| `CachedResource` | Advanced Stable | Cache-backend value contract. |
| `ContractMode` | Stable | General contract schema mode. |
| `DEFAULT_LIVE_HEARTBEAT_INTERVAL` | Advanced Stable | Default SSE heartbeat interval. |
| `DEFAULT_LIVE_MAX_CONNECTION_AGE` | Advanced Stable | Default live connection lifetime. |
| `DEFAULT_LIVE_QUEUE_SIZE` | Advanced Stable | Default in-memory broker queue bound. |
| `DEFAULT_REDIS_CHANNEL_PREFIX` | Advanced Stable | Default Redis live channel prefix. |
| `DEFAULT_REDIS_MAX_MESSAGE_BYTES` | Advanced Stable | Default Redis live-message bound. |
| `DEFAULT_REDIS_MAX_VALUE_BYTES` | Advanced Stable | Default Redis cache-value bound. |
| `DEFAULT_REDIS_SCAN_COUNT` | Advanced Stable | Default Redis cache scan batch size. |
| `ErrorDetail` | Advanced Stable | Protocol error payload model. |
| `ErrorEnvelope` | Advanced Stable | Protocol error envelope model. |
| `FluxFast` | Stable | FastAPI application integrator. |
| `FluxFastError` | Stable | Base FluxFast exception. |
| `FluxFastLiveScopeError` | Stable | Invalid live-resource scope error. |
| `FluxRouter` | Advanced Stable | Standalone FastAPI router integration. |
| `HEADER_CAPABILITIES` | Advanced Stable | Capability-negotiation header name. |
| `InvalidateResource` | Stable | Scoped invalidation descriptor. |
| `LIVE_EVENT_NAME` | Advanced Stable | SSE event name. |
| `LIVE_HEARTBEAT` | Advanced Stable | SSE heartbeat frame. |
| `LIVE_RESYNC_REASONS` | Advanced Stable | Supported live resynchronization reasons. |
| `LiveBroker` | Advanced Stable | Live fan-out protocol. |
| `LiveCoordinator` | Advanced Stable | Scoped live invalidation and patch coordinator. |
| `LiveEvent` | Advanced Stable | Discriminated live-event type. |
| `LiveInvalidateEvent` | Advanced Stable | Live invalidation event model. |
| `LiveMetrics` | Advanced Stable | Process-local live metrics collector. |
| `LiveMetricsSnapshot` | Advanced Stable | Immutable live metrics snapshot. |
| `LivePatchEvent` | Advanced Stable | Live patch event model. |
| `LiveReadyEvent` | Advanced Stable | Live stream ready event model. |
| `LiveResyncEvent` | Advanced Stable | Live resynchronization event model. |
| `LiveResyncReason` | Advanced Stable | Live resynchronization reason type. |
| `LiveSubscription` | Advanced Stable | Authorized live subscription descriptor. |
| `MemoryLiveBroker` | Advanced Stable | Single-process live broker. |
| `MemoryResourceCache` | Advanced Stable | Single-process resource cache. |
| `MutationEnvelope` | Advanced Stable | Protocol mutation envelope model. |
| `MutationPayload` | Advanced Stable | Protocol mutation payload model. |
| `MutationResult` | Stable | Server mutation result descriptor. |
| `PROTOCOL_MEDIA_TYPE` | Advanced Stable | FluxFast JSON media type. |
| `PROTOCOL_VERSION` | Advanced Stable | Browser wire-protocol identifier. |
| `Page` | Stable | Server-driven page descriptor. |
| `PageDescriptor` | Advanced Stable | Protocol page descriptor model. |
| `PageEnvelope` | Advanced Stable | Protocol page envelope model. |
| `PageNotFoundError` | Deprecated | Compatibility-only exception; FluxFast does not raise it. |
| `ProtocolError` | Advanced Stable | Wire-protocol constraint error. |
| `RedisCacheMetrics` | Advanced Stable | Redis cache metrics collector. |
| `RedisCacheMetricsSnapshot` | Advanced Stable | Immutable Redis cache metrics snapshot. |
| `RedisLiveBroker` | Advanced Stable | Multi-worker Redis live broker. |
| `RedisResourceCache` | Advanced Stable | Multi-worker Redis resource cache. |
| `ResourceCacheBackend` | Advanced Stable | Resource cache backend protocol. |
| `ResourceCacheError` | Advanced Stable | Base resource-cache failure. |
| `ResourceCacheSerializationError` | Advanced Stable | Cache serialization failure. |
| `ResourceCacheUnavailableError` | Advanced Stable | Cache availability failure. |
| `ResourceContract` | Stable | Typed logical resource contract. |
| `ResourceContractError` | Stable | Typed resource validation or serialization error. |
| `ResourceError` | Stable | Resource resolution error. |
| `ResourceErrorDetail` | Advanced Stable | Per-resource protocol error model. |
| `ResourceLoader` | Stable | Sync-or-async resource loader type. |
| `ResourceSpec` | Stable | Resource loading and caching descriptor. |
| `ResourceWireRecord` | Advanced Stable | Versioned protocol resource model. |
| `ScopeError` | Stable | Invalid cache-scope error. |
| `ScopeType` | Stable | Cache-scope kind enumeration. |
| `TypeContract` | Stable | General application type contract. |
| `ValidationError` | Deprecated | Compatibility-only exception; FluxFast does not raise it. |
| `append_item` | Stable | Append-item mutation patch builder. |
| `client_supports` | Advanced Stable | Request capability lookup helper. |
| `derive_live_topic` | Advanced Stable | Opaque scoped live-topic derivation. |
| `encode_sse_event` | Advanced Stable | Validated live-event SSE encoder. |
| `flux_external_redirect` | Stable | External browser redirect result builder. |
| `flux_redirect` | Stable | Internal navigation redirect result builder. |
| `invalidate_resource` | Stable | Scoped invalidation builder. |
| `iter_live_events` | Advanced Stable | Live SSE stream iterator. |
| `merge_object` | Stable | Merge-object mutation patch builder. |
| `mutation` | Stable | Mutation result builder. |
| `remove_item` | Stable | Remove-item mutation patch builder. |
| `replace_item` | Stable | Replace-item mutation patch builder. |
| `replace_resource` | Stable | Replace-resource mutation patch builder. |
| `resource` | Stable | Page resource builder. |
| `scope` | Stable | Cache-scope factory. |
<!-- python-api-export-table:end -->

## Stable signatures

The v0.9.0 call shapes are stable throughout 1.x:

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

These compatibility spellings are stable rather than reordered or removed:
the small aesthetic improvement does not justify a breaking change.

## Deprecated exports

`ValidationError` and `PageNotFoundError` have been compatibility-only exports
since the first release and are not raised by the FluxFast runtime.

- For request validation, use FastAPI's validation lifecycle and consume the
  structured FluxFast error envelope. Catch `ResourceContractError` when a
  declared resource contract rejects a loader value.
- For missing routes, use FastAPI/Starlette's ordinary 404 handling or raise
  `fastapi.HTTPException(status_code=404)` in application code.

Existing imports keep working throughout 1.x. New applications should not depend
on either deprecated class.

## What this contract does not cover

The Python export classification does not independently redefine the browser
wire protocol, protocol headers, capability negotiation, developer schema, or
generated files. Those contracts are versioned and stabilized in their
dedicated proofs. See [versioning and compatibility](versioning.md) and the
[wire protocol](protocol.md).
