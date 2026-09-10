# FluxFast Protocol v1

The wire protocol version is `fluxfast/1`; its media type is
`application/vnd.fluxfast+json`. It is versioned independently from Python and
npm packages.

FluxFast 0.9 treats this document and the shared fixtures in
`tests/fixtures/protocol-v1` as the compatibility contract expected through
1.0. This freeze does not create `fluxfast/2` and does not make the protocol
version follow package versions.

## Evolution rules

A compatible `fluxfast/1` change may add optional ignorable metadata, a new
capability-gated behavior, or a response diagnostic header only when older
clients continue to behave correctly without understanding it. New capability
names must have a safe no-capability fallback.

Removing or renaming a field, changing requiredness or existing meaning,
changing patch semantics, or requiring new client behavior is incompatible.
Such a change requires a future `fluxfast/2`; it must not silently reinterpret
`fluxfast/1`.

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
Invalid base64url, duplicate JSON object keys, and oversized metadata invalidate
the optimization; invalid individual records are discarded. Correctness falls
back to transferring values. `X-FluxFast-Only` requests resource-specific
refresh and is limited to 16 KiB before parsing.

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

### Request header contract

Header names are case-insensitive on HTTP. “No FluxFast limit” means the
application does not impose another bound beyond the HTTP server or proxy's
ordinary header limits.

| Header | Required | Purpose and frozen invalid-input behavior | FluxFast limit |
| --- | --- | --- | --- |
| `Accept` | Optional for detection; sent by clients | The FluxFast media type identifies a FluxFast request for structured error handling even without `X-FluxFast`. Other values retain ordinary FastAPI error handling. Live clients send `text/event-stream`. | No FluxFast limit |
| `X-FluxFast` | Optional for detection; sent by clients | The exact value `1` identifies a FluxFast request for structured error handling. Other values do not, unless `Accept` independently identifies it. | No FluxFast limit |
| `X-FluxFast-Protocol` | Optional to the server; sent by clients | The value `1` names `fluxfast/1`. Any explicitly supplied other value produces HTTP 409 with a bounded error envelope that does not reflect the supplied value. | No FluxFast limit |
| `X-FluxFast-Visit` | Sent on page visits and SSR requests | Opaque visit correlation value. The Python backend does not interpret it, so omission or any ordinary header value does not change page correctness. | No FluxFast limit |
| `X-FluxFast-Known` | Optional | Strict base64url JSON object mapping resource keys to opaque versions. Invalid encoding, duplicate object keys, and oversized input invalidate the optimization; unsafe individual records are discarded. Values are then sent normally. | 100 entries; 16 KiB decoded JSON; 128 characters per key and version |
| `X-FluxFast-Only` | Optional | Comma-separated page resource selection for refresh/deferred work. Invalid or empty entries are discarded; unknown keys never escape the route's authorized resource graph. No valid entries means no partial selection. An oversized value produces HTTP 409. | 16 KiB; first 100 entries; 128 characters per accepted key |
| `X-FluxFast-Capabilities` | Optional | Comma-separated additive features. Unknown or malformed tokens are ignored; a non-ASCII, oversized, or over-count header negotiates no capabilities. | 2,048 ASCII bytes; 32 tokens; 64 characters per token |
| `X-FluxFast-Client-ID` | Optional for mutations and live streams | Opaque per-router identity used only to suppress the originating tab's echoed live event. Invalid values produce HTTP 409. | 64 printable ASCII characters |
| `X-FluxFast-Live` | Required to request a live stream | The exact value `1` selects live handling. Other values retain normal page handling. | No FluxFast limit |
| `X-FluxFast-Live-Keys` | Required when `X-FluxFast-Live: 1` | Comma-separated logical keys intersected with the reconstructed authorized page. Missing, malformed, or oversized input produces HTTP 409 rather than widening access. | 16 KiB; 100 keys; 128 characters per key |
| `Content-Type` | Required when a mutation has a JSON body | Clients send `application/json`; malformed request bodies follow FastAPI validation/error handling. | No FluxFast limit |

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
  "deferred": ["analytics"],
  "appVersion": "2026.09.06"
}
```

The frozen page fields are:

| Field | Required | Meaning |
| --- | --- | --- |
| `protocol` | Yes | Exact string `fluxfast/1`. |
| `page` | Yes | Descriptor containing string `component` and `url`; optional `meta` is ignorable application metadata. |
| `resources` | Yes | Map of logical keys to `{ version, value }`; versions are opaque strings. |
| `resourceKeys` | No | Complete authorized logical resource graph when deferred behavior is negotiated, including sent, known, deferred, live, and failed keys. |
| `deferred` | No | Keys still pending a resource-only follow-up. Omitted when none remain. |
| `live` | No | Complete live subset when `live-resources` is negotiated. Empty or absent opens no stream. |
| `resourceErrors` | No | Map of isolated sanitized `{ type, message, details? }` resource failures. |
| `appVersion` | No | Opaque application/deployment version string. It is ignorable metadata and does not alter routing or resource semantics. |

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

Other successful page responses include `X-FluxFast: 1`,
`X-FluxFast-Protocol: 1`, `Server-Timing`, `X-FluxFast-Cache-Hits`,
`X-FluxFast-Cache-Misses`, and `X-FluxFast-Resources-Sent`. These diagnostics
are non-authoritative and ignorable; response-envelope content remains the
source of client state. `X-FluxFast-Live-Resources` is the capability-gated
count described above.

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

The frozen mutation fields are:

| Field | Meaning |
| --- | --- |
| `patches` | Resource-key map of ordered patch lists. |
| `invalidate` | Logical keys made stale after patches are applied. |
| `redirect` | Origin-relative FluxFast visit; backslashes and control characters are rejected so browser URL normalization cannot reinterpret it as another origin. A 404 falls back to full browser navigation. |
| `externalRedirect` | Absolute HTTP(S) full-browser destination. It takes precedence over `redirect`. |

Patch lists apply in order. `replace-resource` replaces the complete value.
`merge-object` requires an object value and shallow-merges its properties, or
uses that object when the current value is not an object. `replace-item`
replaces every selected array item; `remove-item` removes every selected item.
An `id` selector matches an exact ID or the same string representation, while
a `match` selector requires strict equality for every named property.
`append-item` appends to an array or starts a one-item array when the current
value is not an array. Replacement/removal leaves non-array current values
unchanged. `replace-resource`, `merge-object`, `replace-item`, and `append-item`
require `value`; item replacement/removal requires a string/integer `id` or a
non-empty `match` object. These names and meanings must not be reinterpreted
within `fluxfast/1`.

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
`error.type` and `error.message` are strings; `error.details` is optional,
arbitrary sanitized metadata and may explicitly be `null`.

## Compatibility fixtures

The JSON files in [`tests/fixtures/protocol-v1`](../tests/fixtures/protocol-v1)
are golden examples for normal pages, known-version deltas, partial loads,
deferred pages and failures, live manifests, mutation patches and invalidation,
both redirect forms, validation errors, and resource errors. Python Pydantic
models must validate and round-trip them; the framework-neutral TypeScript
consumer must validate or consume the same files. Fixture changes therefore
receive protocol compatibility review rather than routine snapshot updates.

The two frozen capability names are `deferred-resources` and `live-resources`.
A new backend with an old client must retain blocking/non-live behavior when
the capability header is absent. A new client with an old backend must remain
correct when its unknown capability is ignored. No third capability is part of
the v0.9 contract.

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
