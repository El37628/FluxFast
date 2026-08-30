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
X-FluxFast-Capabilities: deferred-resources
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
clients. FluxFast 0.3 clients advertise `deferred-resources` on initial SSR,
navigation, refresh, prefetch, and mutation requests.

`deferred-resources` is the only capability defined by FluxFast 0.3. Capability
names are published only when their wire behavior ships; experimental or future
features must not rely on undeclared tokens.

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
