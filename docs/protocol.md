# FluxFast Protocol v1

The wire protocol version is `fluxfast/1`; its media type is
`application/vnd.fluxfast+json`. It is versioned independently from Python and
npm packages.

## Visit request

```http
GET /rooms?status=available HTTP/1.1
Accept: application/vnd.fluxfast+json
X-FluxFast: 1
X-FluxFast-Protocol: 1
X-FluxFast-Visit: visit_123
X-FluxFast-Known: <base64url JSON object>
X-FluxFast-Only: rooms,summary
X-FluxFast-Capabilities: deferred-resources,live-resources
```

`X-FluxFast-Known` maps logical keys to opaque versions. Limits are 100 records,
16 KiB decoded JSON, 128 characters per key, and 128 characters per version.
Invalid or oversized metadata is ignored or omitted; correctness falls back to
transferring values. `X-FluxFast-Only` requests resource-specific refresh.

`X-FluxFast-Capabilities` is an optional, comma-separated list of additive
client features and is independent of `fluxfast/1`. Capability tokens contain
only lowercase ASCII letters, digits, and hyphens. Servers bound parsing to a
2,048-byte header, 32 tokens, and 64 characters per token; malformed and unknown
capabilities are ignored. A missing header preserves the behavior of older
clients. FluxFast 0.4 clients advertise `deferred-resources` and
`live-resources` on initial SSR, navigation, refresh, prefetch, and mutation
requests.

`deferred-resources` was introduced in FluxFast 0.3. `live-resources` is the
additive FluxFast 0.4 extension described below. Capability names are published
only when their wire behavior ships; experimental or future features must not
rely on undeclared tokens.

An explicitly unsupported `X-FluxFast-Protocol` receives a 409 protocol error.

## Page envelope

```json
{
  "protocol": "fluxfast/1",
  "page": {
    "component": "rooms/index",
    "url": "/rooms?status=available",
    "meta": { "title": "Rooms" }
  },
  "resourceKeys": ["rooms", "analytics"],
  "resources": {
    "rooms": {
      "version": "f81d94f7a18e...",
      "value": []
    }
  },
  "deferred": ["analytics"]
}
```

Resources already known at the same server-cached version are absent. Search
parameters remain part of `page.url`. For clients that advertise the
`deferred-resources` capability, `resourceKeys` lists the complete logical
resource graph and `deferred` lists cache-miss resources whose loaders still
need a resource-only follow-up request. An optional `resourceErrors` object maps
resource keys to sanitized `{ type, message, details? }` errors. These fields
are additive: old envelopes without them remain valid, and servers omit them
for clients that do not advertise deferred-resource support.

`resourceKeys` includes ready, known-version-omitted, deferred, and failed keys;
it is the page manifest used for cache validity. `deferred` appears only when at
least one key remains pending. A valid deferred cache hit is returned in
`resources`, or omitted through `X-FluxFast-Known`, and is not listed in
`deferred`.

For clients advertising `live-resources`, the page response also includes a
count-only diagnostic header:

```http
X-FluxFast-Live-Resources: 2
```

The value is the number of keys in the authoritative `live` manifest. Resource
names, scopes, scope fingerprints, and broker topics are never placed in this
header. The header is omitted for clients that did not negotiate the live
capability.

## Deferred follow-up

After applying an initial envelope with pending keys, the browser requests the
same authoritative FastAPI page and selects only those resources:

```http
GET /rooms?status=available HTTP/1.1
Accept: application/vnd.fluxfast+json
X-FluxFast: 1
X-FluxFast-Protocol: 1
X-FluxFast-Capabilities: deferred-resources
X-FluxFast-Only: analytics
X-FluxFast-Known: <base64url JSON object>
```

A successful follow-up is still a page envelope, but its page descriptor is not
applied as navigation state:

```json
{
  "protocol": "fluxfast/1",
  "page": {
    "component": "rooms/index",
    "url": "/rooms?status=available"
  },
  "resourceKeys": ["rooms", "analytics"],
  "resources": {
    "analytics": {
      "version": "91ee03f09b6c...",
      "value": { "revenue": 95000 }
    }
  }
}
```

If a deferred loader fails, its key is absent from `resources` and appears in
`resourceErrors`; successful siblings remain in the same response. An unchanged
known resource may be absent from both maps and is settled from the browser's
existing record. The client updates only resource state—never `PageStore`, URL,
scroll, or browser history—for this response.

`X-FluxFast-Only` is not a global resource lookup API. The server re-executes
the FastAPI route and dependencies, then resolves only requested keys that the
current page actually declares. Resource keys remain bounded by the existing
header count and length limits.

## Deferred compatibility

- **Old client, new server:** without `deferred-resources`, every declared
  loader remains blocking and the additive fields are omitted.
- **New client, old server:** an ordinary v1 envelope without `resourceKeys`,
  `deferred`, or `resourceErrors` is handled with the pre-deferred behavior.
- **Unknown capability:** bounded parsing ignores it without changing the
  response contract.
- **Unknown additive field:** compatible v1 clients ignore fields they do not
  need; a required or incompatible semantic change still needs a new protocol.

The negotiation therefore adds progressive resource loading while the protocol
identifier remains `fluxfast/1`.

## Response diagnostics

Every page-envelope response includes count-only deferred diagnostics alongside
the existing cache and resource headers:

```http
X-FluxFast-Deferred-Pending: 1
X-FluxFast-Deferred-Errors: 0
```

`X-FluxFast-Deferred-Pending` counts keys left for a deferred follow-up in that
response. `X-FluxFast-Deferred-Errors` counts isolated deferred loader failures
returned in `resourceErrors`. Legacy/blocking responses report zero. The headers
never expose cache scopes, tenant identifiers, or server cache keys.

## Mutation envelope

```json
{
  "protocol": "fluxfast/1",
  "mutation": {
    "patches": {
      "rooms": [
        { "op": "replace-item", "id": 101, "value": { "id": 101 } }
      ]
    },
    "invalidate": ["summary"],
    "redirect": "/rooms",
    "externalRedirect": "https://example.com/login"
  }
}
```

The five patch operations are `replace-resource`, `merge-object`,
`replace-item`, `remove-item`, and `append-item`. All mutation fields are
optional and absent fields are omitted rather than encoded as `null`.
`externalRedirect` is an optional additive v1 field; the legacy
`X-FluxFast-External-Redirect` response header is also accepted.

Patches apply first, invalidations second, then active invalidated resources are
partially refreshed unless a redirect takes precedence.

## Error envelope

```json
{
  "protocol": "fluxfast/1",
  "error": {
    "type": "ValidationError",
    "message": "Request validation failed",
    "details": { "email": ["Invalid email"] }
  }
}
```

Clients validate envelope shape and protocol before applying state. Breaking
wire semantics require a new protocol version; optional additive fields may
remain v1 after compatibility review.

## Live Resources

FluxFast 0.4 implements Live Resources as an additive v1 capability. The
architectural rationale is recorded in
[ADR-0004](decisions/0004-live-resource-transport.md). Package versions and the
wire protocol remain independent: this feature does not change the
`fluxfast/1` identifier.

Live events are synchronization signals, not an authoritative event log. The
canonical value continues to come from the resource loader through the existing
resource-only page request.

### Capability and page manifest

A capable 0.4 client adds `live-resources` to its existing capability header:

```http
X-FluxFast-Capabilities: deferred-resources,live-resources
```

For such clients, a page envelope may contain `live`, the complete logical-key
set of live resources declared by the current page:

```json
{
  "protocol": "fluxfast/1",
  "page": {
    "component": "dashboard/index",
    "url": "/dashboard"
  },
  "resourceKeys": ["summary", "activity"],
  "resources": {
    "summary": {
      "version": "f81d94f7a18e...",
      "value": { "revenue": 120000 }
    }
  },
  "deferred": ["activity"],
  "live": ["summary", "activity"]
}
```

`live` may include blocking, deferred, cached, and known-version-omitted
resources. A key does not need to be ready to be live. The field is omitted
unless the client advertised `live-resources`; an empty or absent field opens no
stream.

### Live subscription request

After hydration, the client opens at most one live stream for the active page.
It sends a streaming request to the page's authoritative URL through the normal
frontend origin:

```http
GET /dashboard HTTP/1.1
Accept: text/event-stream
X-FluxFast: 1
X-FluxFast-Protocol: 1
X-FluxFast-Capabilities: deferred-resources,live-resources
X-FluxFast-Live: 1
X-FluxFast-Live-Keys: summary,activity
X-FluxFast-Client-ID: ff_018f7d2...
```

The server reruns the FastAPI route and its dependencies to authenticate and
authorize the subscription. It intersects `X-FluxFast-Live-Keys` with live
resources declared by that reconstructed page and derives scopes exclusively
from those server declarations. Stream setup must not execute resource loaders.
The header never contains scopes or broker topics.

Live-key metadata is bounded to 100 keys, 128 characters per key, and 16 KiB in
total. `X-FluxFast-Client-ID` is random, opaque, non-sensitive, and at most 64
characters. Invalid or oversized live metadata rejects the live request rather
than widening its subscription.

The successful response uses:

```http
Content-Type: text/event-stream
Cache-Control: no-cache, no-transform
X-Accel-Buffering: no
```

SSE comments such as `: ping` are transport heartbeats and do not change client
state. The server may periodically close a stream to revalidate authorization;
the client reconnects and resynchronizes.

### Client identity

Each browser tab/router instance creates one client ID for its lifetime. It
sends the same `X-FluxFast-Client-ID` on live requests and FluxFast mutation
requests. Events may echo that ID as `originClientId`; only the matching client
suppresses that event. Other tabs have distinct IDs and still receive it.

### Event framing and models

Application events use one SSE event name and a JSON payload:

```text
event: fluxfast
data: {"protocol":"fluxfast/1","type":"ready","keys":["summary"]}

```

The additive event union is:

```json
{
  "protocol": "fluxfast/1",
  "type": "ready",
  "keys": ["summary", "activity"]
}
```

```json
{
  "protocol": "fluxfast/1",
  "type": "invalidate",
  "keys": ["summary"],
  "originClientId": "ff_018f7d2..."
}
```

```json
{
  "protocol": "fluxfast/1",
  "type": "patch",
  "patches": {
    "rooms": [
      {
        "op": "replace-item",
        "id": 101,
        "value": { "id": 101, "status": "occupied" }
      }
    ]
  },
  "originClientId": "ff_018f7d2..."
}
```

```json
{
  "protocol": "fluxfast/1",
  "type": "resync",
  "keys": ["summary", "activity"],
  "reason": "overflow"
}
```

`ready` confirms that the requested subscription is active. After a reconnect,
the client treats readiness as an instruction to reload every active live key.
`invalidate` preserves current values, marks the named resources stale, and
coalesces their canonical resource-only refresh. `patch` reuses the mutation
patch operations for an immediate UI update, then performs canonical refresh.
If a patch targets a missing resource, the client skips the partial patch and
loads that key. `resync` means events may have been missed; its reason is one of
`overflow`, `reconnect`, `broker-recovery`, or `server`.

Unknown event types, malformed JSON, invalid patches, unsupported protocols,
oversized fields, and keys outside the active manifest must not mutate resource
state. The client may ignore the event, report a safe diagnostic, or schedule a
canonical resync.

### Delivery and compatibility

Delivery is at-most-current-state, not exactly once. Events may be duplicated
or lost across disconnects. Per-subscriber queues are bounded; overflow results
in a `resync` signal or a closed connection followed by reconnect and canonical
reload. No persistent replay or `Last-Event-ID` contract is defined for 0.4.

- **Python 0.4 with a 0.3 client:** the client omits `live-resources`, so the
  server omits `live`, opens no stream, and resolves resources with 0.3
  semantics.
- **Next/core 0.4 with Python 0.3:** the server emits no `live` manifest, so the
  client opens no stream and retains ordinary 0.3 behavior.
- **Unknown additive fields or capabilities:** existing bounded parsing rules
  apply and the protocol identifier remains `fluxfast/1`.
