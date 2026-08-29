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
```

`X-FluxFast-Known` maps logical keys to opaque versions. Limits are 100 records,
16 KiB decoded JSON, 128 characters per key, and 128 characters per version.
Invalid or oversized metadata is ignored or omitted; correctness falls back to
transferring values. `X-FluxFast-Only` requests resource-specific refresh.

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
  "resources": {
    "rooms": {
      "version": "f81d94f7a18e...",
      "value": []
    }
  }
}
```

Resources already known at the same server-cached version are absent. Search
parameters remain part of `page.url`.

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
