# ADR-0004: Use fetch-based SSE for Live Resources

Status: accepted.

## Context

FluxFast mutations already carry browser-to-server writes over HTTP. Live
Resources need the opposite direction: a server signal that tells an authorized
browser to refresh or temporarily patch an existing resource.

Live requests must use FluxFast headers for capability negotiation, logical
resource keys, protocol version, and an opaque client identity. Native
`EventSource` cannot attach those application-defined request headers.

## Decision

FluxFast 0.4 uses Server-Sent Events over browser `fetch()` and
`ReadableStream` as its default live transport.

The stream targets the current authoritative FastAPI page URL through the same
origin used by the Next.js adapter. FastAPI reconstructs the page, runs its
authentication and authorization dependencies, intersects the requested keys
with the page's declared live resources, derives opaque scoped broker topics,
and then subscribes. Stream setup never executes resource loaders.

The client implementation sits behind a framework-neutral transport interface
in `@fluxfast/core`. React and Next.js integration may consume that interface,
but must not become dependencies of the core package.

Live messages are synchronization signals rather than an authoritative event
log. After invalidation, reconnect, uncertainty, or an immediate patch, the
client converges through the existing resource-only HTTP loader path.

## Consequences

- One-way server push matches the 0.4 requirement while mutations continue to
  use ordinary HTTP.
- Custom request headers, `AbortController`, navigation cancellation, and the
  existing same-origin rewrite remain available.
- Deployment is simpler than a WebSocket upgrade path, but proxies must disable
  buffering and permit long-lived streaming responses.
- The server must send heartbeats, bound subscriber queues, and force canonical
  resynchronization after reconnect or overflow.
- The default in-memory broker supports only one process. Multi-worker
  deployments require the optional Redis broker.
- WebSockets may be added behind the transport abstraction in a future release,
  without changing the resource model or introducing another frontend store.

## Rejected alternatives

**Native `EventSource`:** rejected because it cannot send the required custom
request headers.

**WebSockets in 0.4:** rejected because bidirectional messaging, upgrades, and a
second connection protocol add complexity without a current product need.

**Polling:** rejected because it performs work without a change signal and does
not meet the live synchronization goal.

**Authoritative pushed state:** rejected for 0.4 because delivery can be
duplicated, dropped, or interrupted. Canonical resource loaders remain the
correctness boundary.
