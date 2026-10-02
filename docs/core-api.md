# `@fluxfast/core` public API

FluxFast 1.x treats the framework-neutral runtime exported from
the official `@fluxfast/core` package root as stable. The package intentionally
keeps its existing browser-facing public import path:

```ts
import { FluxRouter, createValidator } from "@fluxfast/core";
```

Deep imports into `dist` or source files are internal. The package's ESM and
CommonJS entry points expose the same named API.

Unreleased v1.2 foundation work adds a separate server integration path,
`@fluxfast/core/server`. It is not available in the published v1.1 packages.
Server helpers are never re-exported from the browser-facing root; existing
Next.js applications keep their current imports and behavior.

The [adapter implementation contract](adapter-contract.md) describes how these
public primitives fit into an SSR host without duplicating Core's navigation,
resource, mutation, deferred, or live authority.

Application developers should begin with the [Stable APIs guide](stable-apis.md).
Adapter, transport, live-runtime, protocol, and validation-tooling authors
should also read [Advanced Stable APIs](advanced-stable-apis.md). This page is
the authoritative symbol inventory for both classifications.

## Common API inputs and outputs

Application components normally reach this runtime through `@fluxfast/next`.
The direct API is useful for adapter authors, non-React clients, validation,
and tests.

### Hydrate the framework-neutral runtime

`FluxRouter` accepts the same `PageEnvelope` returned by FastAPI. Supplying
`deferHistory: true` keeps this standalone example independent of the browser
History API.

```ts
import { FluxRouter, type PageEnvelope } from "@fluxfast/core";

const initialEnvelope: PageEnvelope = {
  protocol: "fluxfast/1",
  page: {
    component: "rooms/index",
    url: "/rooms",
    meta: { title: "Rooms" },
  },
  resources: {
    rooms: {
      version: "rooms-v1",
      value: [{ id: 101, status: "available" }],
    },
  },
};

const router = new FluxRouter({
  initialEnvelope,
  deferHistory: true,
});

console.log({
  page: router.pageStore.getSnapshot(),
  rooms: router.resourceStore.getSnapshot("rooms"),
  resourceStatus: router.resourceStore.getStateSnapshot("rooms").status,
});
```

Output:

```json
{
  "page": {
    "component": "rooms/index",
    "url": "/rooms",
    "meta": { "title": "Rooms" }
  },
  "rooms": [{ "id": 101, "status": "available" }],
  "resourceStatus": "ready"
}
```

Use `createFluxRuntime(options)` when a factory is more convenient; it returns
the same `FluxRouter` public runtime.

### Observe development diagnostics

Every `FluxRouter` owns a `diagnostics` hub. It is inactive until a development
tool subscribes, so normal application execution does not allocate diagnostic
events. The hub distributes observations only; it does not retain a runtime
timeline. Adapters may use `bootstrap()` for one bounded, one-shot batch
captured before a browser listener could exist, such as the initial SSR trace.
The first subscriber consumes that batch; long-term history remains the
DevTools consumer's responsibility.

```ts
const stop = router.diagnostics.subscribe(event => {
  console.log(event.type, event.correlationId, event.data);
});

await router.visit("/rooms?token=not-recorded");
stop();
```

A navigation emits correlated `navigation`, `page-cache`, and
`resource-update` observations. Runtime diagnostics contain bounded metadata
such as route paths, resource keys, versions, counts, phases, and error types.
They omit query strings, headers, request bodies, resource values, and raw
error messages. DevTools consumers should still treat the channel as
development-only and keep their own bounded history.

The built-in `FetchTransport` is attached automatically. While at least one
listener is active, it adds the development opt-in header, records bounded
browser timing, validates the response trace, and emits correlated `transport`
and `server-trace` observations. Removing the final listener restores the
ordinary request path and suppresses the opt-in header. Custom transports remain
compatible; they may implement the optional `attachDiagnostics(hub)` method to
participate.

For the current store state, use the value-free inspection snapshot:

```ts
console.log(router.resourceStore.getRecordsSnapshot());
```

```json
[
  {
    "key": "rooms",
    "version": "rooms-v1",
    "updatedAt": 1760000000000,
    "status": "ready",
    "stale": false,
    "hasSubscribers": true
  }
]
```

Pending or error-only resources use `null` for `version` and `updatedAt`. The
snapshot never contains `value`, error messages, or error detail objects.

### Validate unknown input

Generated validators use this API internally. A custom integration can also
construct a deterministic plan directly:

```ts
import { createValidator } from "@fluxfast/core";

interface Room {
  id: number;
  status: "available" | "occupied";
}

const roomValidator = createValidator<Room>({
  kind: "object",
  properties: {
    id: { kind: "integer", minimum: 1 },
    status: {
      kind: "enum",
      values: ["available", "occupied"],
    },
  },
  required: ["id", "status"],
  additionalProperties: false,
});

console.log(roomValidator.validate({ id: 0, status: "unknown" }));
```

Output:

```json
{
  "valid": false,
  "issues": [
    {
      "path": ["id"],
      "code": "minimum",
      "message": "Value must be at least 1."
    },
    {
      "path": ["status"],
      "code": "enum",
      "message": "Value is not one of the allowed values."
    }
  ]
}
```

A valid input returns `{ valid: true, value, issues: [] }`. `is()` exposes a
TypeScript type guard, while `assert()` returns the typed value or throws
`ValidationError` with the same structured issues.

### Apply a mutation patch

`applyPatchToValue()` is the pure operation used by the resource store for one
patch. It does not mutate the input value.

```ts
import { applyPatchToValue } from "@fluxfast/core";

const rooms = [
  { id: 101, status: "available" },
  { id: 102, status: "occupied" },
];

const updated = applyPatchToValue(rooms, {
  op: "replace-item",
  id: 101,
  value: { id: 101, status: "occupied" },
});

console.log(updated);
```

Output:

```json
[
  { "id": 101, "status": "occupied" },
  { "id": 102, "status": "occupied" }
]
```

The runtime also supports `replace-resource`, `merge-object`, `remove-item`,
and `append-item` operations. The server remains responsible for deciding which
patches are authorized and authoritative.

## Classification

A stable API is part of the ordinary application or adapter-author surface. An
advanced stable API supports lower-level transport, cache, live, protocol, or
generated-validation integrations. Both classifications are supported
compatibility-sensitive API; advanced does not mean experimental.

The frozen v0.9.0 inventory remains machine-checked while reviewed, additive
1.x APIs are recorded explicitly. Every exported name must appear exactly once.

### Stable

<!-- core-api-stable:start -->
```text
ComponentResolutionError
EventEmitter
FluxEventListener
FluxEventName
FluxEventPayloads
FluxFastError
FluxResourceKey
FluxResourceMap
FluxResourceValue
FluxRouter
FluxRuntimeOptions
FluxValidator
LoadResourcesOptions
MutateOptions
MutationError
PageNotFoundError
PageState
PageStore
PatchOp
ProtocolError
RefreshOptions
ResourceError
ResourceErrorEvent
ResourceLoadErrorEvent
ResourceLoadEvent
ResourceLoadReason
ResourcePatch
ResourceRecord
ResourceStateSnapshot
ResourceStatus
ResourceStore
TransportError
ValidationError
ValidationIssue
ValidationLimits
ValidationOptions
ValidationPath
ValidationPathSegment
ValidationResult
ValidatorRefinement
VersionMismatchError
VisitOptions
applyPatchToValue
createFluxRuntime
createValidationIssue
createValidator
displayValidationKey
formatValidationPath
refineValidator
```
<!-- core-api-stable:end -->

### Advanced stable

<!-- core-api-advanced:start -->
```text
CAPABILITY_DEFERRED_RESOURCES
CAPABILITY_LIVE_RESOURCES
CachedPage
CompiledValidationPlan
DEVTOOLS_PROTOCOL_VERSION
DEFAULT_LIVE_RECONNECT_INITIAL_DELAY_MS
DEFAULT_LIVE_RECONNECT_JITTER
DEFAULT_LIVE_RECONNECT_MAX_DELAY_MS
DEFAULT_VALIDATION_MAX_DEPTH
DEFAULT_VALIDATION_MAX_ISSUES
DEFAULT_VALIDATION_MAX_OPERATIONS
DEFAULT_VALIDATION_MAX_PROPERTIES
ErrorDetail
ErrorEnvelope
FLUX_CAPABILITIES
FetchSseLiveTransport
FetchTransport
FluxCapability
FluxDiagnosticEvent
FluxDiagnosticEventType
FluxDiagnosticListener
FluxDiagnosticsHub
FluxServerDiagnosticTrace
FluxSseParser
FluxTransport
HEADER_CAPABILITIES
HEADER_CLIENT_ID
HEADER_DEVTOOLS
HEADER_DEVTOOLS_TRACE
HEADER_LIVE
HEADER_LIVE_KEYS
HistoryManager
HistoryOptions
LIVE_EVENT_NAME
LIVE_RESYNC_REASONS
LiveConnection
LiveConnectionCloseEvent
LiveConnectionEvent
LiveConnectionOptions
LiveConnectionStatus
LiveEvent
LiveInvalidateEvent
LiveManager
LiveManagerDiagnostic
LiveManagerOptions
LiveManifest
LiveNetworkAdapter
LivePatchEvent
LiveReadyEvent
LiveResyncEvent
LiveResyncReason
LiveStatusSnapshot
LiveTransport
MAX_DEVTOOLS_TRACE_HEADER_CHARS
MAX_LIVE_CLIENT_ID_LENGTH
MAX_LIVE_EVENT_BYTES
MAX_LIVE_EVENT_KEYS
MAX_LIVE_KEYS_HEADER_BYTES
MAX_LIVE_RESOURCE_KEY_LENGTH
MutationEnvelope
MutationPayload
MutationTransportRequest
PROTOCOL_MEDIA_TYPE
PROTOCOL_VERSION
PageCache
PageCacheManifest
PageDescriptor
PageEnvelope
PopStateCallback
PrefetchEntry
PrefetchManager
ProtocolVersion
ResourceErrorDetail
ResourceMetadataSnapshot
ResourceWireRecord
VALIDATION_FORMATS
VALIDATION_PATTERN_MAX_LENGTH
ValidationAnyPlan
ValidationArrayPlan
ValidationBooleanPlan
ValidationEnumPlan
ValidationFormat
ValidationIntersectionPlan
ValidationLiteralPlan
ValidationNeverPlan
ValidationNode
ValidationNullPlan
ValidationNumberPlan
ValidationObjectPlan
ValidationOneOfPlan
ValidationPlan
ValidationPlanDocument
ValidationRefPlan
ValidationReferenceTarget
ValidationStringPlan
ValidationTuplePlan
ValidationUnionPlan
VisitTransportRequest
assertClientId
assertLiveEvent
assertMutationEnvelope
assertPageEnvelope
compileValidationPlan
createClientId
createFetchSseLiveTransport
createFetchTransport
createLiveManager
decodeServerDiagnosticTrace
encodeKnownVersions
evaluateValidationPlan
isSupportedValidationFormat
isValidationPlanDocument
prepareValidationPlan
serializeCapabilities
serializeLiveKeys
validateValidationFormat
validateWithPlan
validationPatternError
```
<!-- core-api-advanced:end -->

No `@fluxfast/core` root export is deprecated in v0.9. Runtime classes,
interfaces, constants, and helpers listed above remain supported even when
ordinary Next.js applications normally access them through `@fluxfast/next`.

## Server adapter primitives (unreleased v1.2)

These Advanced Stable APIs are for server-side adapter integrations, not React
components. They use standard `Headers`, `Request`, `Response`, and `fetch`
types without a framework or Node dependency. Diagnostics policy and the backend
address are explicit host inputs, never environment lookups inside Core.

<!-- core-server-api-advanced:start -->
```text
FetchFluxInitialPageOptions
FluxDevelopmentMetadata
FluxInitialPageResult
FluxTransportProxyOptions
createFluxTransportProxy
fetchFluxInitialPage
removeFluxHopByHopHeaders
selectFluxForwardHeaders
```
<!-- core-server-api-advanced:end -->

### Fetch an initial page independently of a framework

The following server-side example assumes a running private FastAPI backend
whose `/rooms` route selects `rooms/index` and returns a valid `fluxfast/1`
envelope. Replace the illustrative session cookie with the incoming request's
headers selected by your host. No React or Next.js import is needed:

```ts
import { fetchFluxInitialPage, selectFluxForwardHeaders } from "@fluxfast/core/server";

const result = await fetchFluxInitialPage({
  backendUrl: "http://127.0.0.1:8000",
  path: "/rooms?status=available",
  headers: selectFluxForwardHeaders({ cookie: "session=example" }),
  diagnostics: false,
  maxRedirects: 20,
});

if (result.type === "not-found") {
  console.log("404"); // The host decides how to send/render its real 404.
} else {
  console.log(result.envelope.page.component);
  // Render the allowlisted module using this same envelope for hydration.
}
```

For that route the output is `rooms/index`; a valid HTTP 404 response returns
`{ type: "not-found" }`. Core does not call `notFound()`, render a component,
resolve a frontend module, or fetch again to hydrate the browser.

The helper sends a GET with `cache: "no-store"`, manual redirects, authoritative
FluxFast media/protocol/capability headers, and an SSR visit identifier. Explicit
input headers are sanitized for per-hop fields; use `selectFluxForwardHeaders`
when deriving them from an incoming request so arbitrary browser headers are not
forwarded. The input collection is not mutated. An injected `fetch` option is
useful for custom hosts and tests; the default is `globalThis.fetch`.

The path must be origin-relative, begin with `/` but not `//`, and contain no
raw whitespace, control characters, or backslashes. Encode segments and queries
before passing them. Backend URLs must use HTTP(S) without user information,
query, or fragment; an explicit backend path prefix is retained. Invalid
configuration is rejected before any fetch, without reflecting credentials.

Canonical redirects retain authentication only within the configured backend
origin. Other origins and redirect user information are rejected. Discarded
redirect bodies are cancelled before following or rejecting them. The default
is twenty redirects; `maxRedirects` accepts a non-negative safe integer, and
zero disables following redirects.

Successful envelopes are validated before returning. Ordinary HTTP errors
retain `TransportError` status, server message/detail, and parsed payload. Error
bodies are bounded to 1 MiB of streamed bytes independently of Content-Length;
an oversized body is cancelled and produces a generic `TransportError` without
retaining it. This bound does not apply to successful application resource data.
Non-JSON bodies retain the initial-response parse failure, including non-JSON
404s. Native fetch rejection is propagated when no HTTP response exists.

Diagnostics are disabled by default. The host must set `diagnostics: true` only
for its trusted development environment: Core does not inspect `NODE_ENV`.
Caller-supplied diagnostic opt-in headers are discarded, then the explicit flag
determines the request header and optional separate `development` metadata.
Valid traces use the existing bounded decoder and a query-free, capped initial
pathname. Invalid, unsupported, oversized, or unsafe traces do not affect the
page result. Diagnostics never become a field in `PageEnvelope`.

### Proxy browser transport requests without a framework

Use this helper inside a server host's existing HTTP handler. The host maps its
route parameters to an encoded origin-relative pathname; the incoming `Request`
supplies the query, method, headers, body, and cancellation signal. Core does not
choose application routes or perform authorization: FastAPI still owns both.

For the same running `/rooms` backend used above:

```ts
import { createFluxTransportProxy } from "@fluxfast/core/server";

const proxy = createFluxTransportProxy({ backendUrl: "http://127.0.0.1:8000" });
const incoming = new Request("https://app.example/transport/rooms?status=available", {
  headers: {
    Accept: "application/vnd.fluxfast+json",
    "X-FluxFast": "1",
    "X-FluxFast-Protocol": "1",
    cookie: "session=example",
  },
});
const response = await proxy(incoming, "/rooms");
console.log(response.status);
console.log((await response.json()).page.component);
```

For an authorized, successful route, the output is:

```text
200
rooms/index
```

The actual backend target is `/rooms?status=available`; the frontend-only
`/transport` prefix is not forwarded. The argument is an already encoded
pathname, not a URL or a query string: pass `/rooms/a%2Fb` for a segment containing
`/`, and retain the original query on the incoming request. Backend path prefixes
are retained. Missing leading slashes, network-path URLs, raw whitespace/control
characters/backslashes, query/fragment markers, malformed escapes, and raw or
percent-encoded dot segments are rejected with a non-cacheable HTTP 400 without
fetching. A request without the exact `X-FluxFast: 1` marker gets an empty,
non-cacheable HTTP 404 before backend configuration is read.

The proxy preserves HTTP methods and buffers non-GET/HEAD request bodies as the
existing Next adapter does, including binary mutation payloads. Native body-read
errors remain native errors. It forwards end-to-end request and response headers
through the shared hop-header sanitizer, including cookies, authorization, CSRF,
FluxFast capability/live headers, diagnostics, and separate `Set-Cookie` values.
It does not apply the restrictive SSR allowlist to protocol requests. It drops
request `accept-encoding` so the upstream fetch negotiates compression.

Requests use `cache: "no-store"`, `redirect: "manual"`, and the original request
signal. Backend statuses, error body bytes, and redirect locations are forwarded
unchanged, not parsed into a different envelope; unlike the initial SSR helper,
the proxy never follows an external or canonical HTTP redirect with credentials.
The response body stays an unbuffered stream: open SSE arrives incrementally and
downstream cancellation reaches the upstream stream. A host must return this
response directly, not call `text()` or `json()` on a live stream as the page
example does.

An injected `fetch` is optional; the default is captured from `globalThis.fetch`
when the proxy is created. Core reads no adapter environment variables. Invalid
HTTP(S) backend configuration (including URL credentials, queries, or fragments)
and upstream fetch failures return a non-cacheable, generic HTTP 503:

```json
{"error":{"code":"transport_unavailable","message":"FluxFast backend is unavailable"}}
```

Private backend addresses, credential values, and native exception text are
never logged or included in that error. In Next.js, continue using the existing
`createFluxTransportHandler` API: the adapter delegates to this helper and still
resolves the supervisor's private backend address for each request.

### Select headers for initial SSR

```ts
import { selectFluxForwardHeaders } from "@fluxfast/core/server";

const incoming = new Headers({
  cookie: "session=example",
  authorization: "Bearer example",
  "accept-language": "en",
  "user-agent": "Example Browser",
  "x-tenant": "trusted-tenant-header",
  "x-unrelated": "do-not-forward",
  connection: "keep-alive, x-hop",
  "x-hop": "do-not-forward",
});

const forwarded = selectFluxForwardHeaders(incoming, ["X-Tenant", "X-Hop"]);
console.log(Object.fromEntries(forwarded));
```

Output (illustrative credentials only):

```json
{
  "accept-language": "en",
  "authorization": "Bearer example",
  "cookie": "session=example",
  "user-agent": "Example Browser",
  "x-tenant": "trusted-tenant-header"
}
```

The default allowlist contains cookie, authorization, accept-language, and
user-agent. The second argument adds explicit field names; it does not replace
the defaults. Names are case-insensitive and malformed configured names are
ignored. Standard hop-by-hop headers and fields nominated by `Connection` are
removed even when allowlisted. The input is never mutated.

Forwarding a header does not make its contents trustworthy. FastAPI must still
authenticate and authorize the request, including any tenant selection. Never
log a real `forwarded` collection or disclose credentials in an error report.

### Sanitize proxy request or response headers

```ts
import { removeFluxHopByHopHeaders } from "@fluxfast/core/server";

const clean = removeFluxHopByHopHeaders({
  "content-type": "text/event-stream",
  "cache-control": "no-cache, no-transform",
  "x-accel-buffering": "no",
  connection: "keep-alive, x-private-hop",
  "x-private-hop": "discard",
  "transfer-encoding": "chunked",
});
console.log(Object.fromEntries(clean));
```

```json
{
  "cache-control": "no-cache, no-transform",
  "content-type": "text/event-stream",
  "x-accel-buffering": "no"
}
```

This helper copies all end-to-end fields rather than applying the SSR allowlist.
It preserves separate `Set-Cookie` values and safe SSE/FluxFast headers. It strips
connection, content-length, host, keep-alive, proxy-authenticate,
proxy-authorization, te, trailer, transfer-encoding, upgrade, and valid
`Connection`-nominated fields. A proxy remains responsible for forwarding the
body as a stream and negotiating compression correctly; sanitizing headers alone
does not implement a transport proxy.

Invalid input headers produce a generic `TypeError("Invalid FluxFast headers")`
without reflecting the supplied value or attaching the native error as a cause.

### Server contract types

`FetchFluxInitialPageOptions` names an explicit backend URL, origin-relative
path, optional `HeadersInit`, optional injected `fetch`, optional diagnostics
flag, and optional redirect bound. `FluxInitialPageResult` is either a page
envelope with optional safe `FluxDevelopmentMetadata` or a `not-found` result
for the host to translate into its own response. `FluxTransportProxyOptions`
names the backend URL and an optional injected fetch implementation.

These types describe the shared server contract. Initial-page fetching and
transport proxying are available independently. The unreleased Next.js adapter
delegates both HTTP boundaries and header sanitation to these primitives while
retaining framework rendering, not-found control flow, route parameters, and
backend environment policy.

Each exported type can also be used independently when describing an adapter
boundary. The declarations below are examples, not an instruction to replace
the current Next integration:

<!-- core-server-api-examples:start -->
| API | Declaration or use | Purpose |
| --- | --- | --- |
| `FetchFluxInitialPageOptions` | `const options: FetchFluxInitialPageOptions = { backendUrl: "http://127.0.0.1:8000", path: "/rooms", diagnostics: false };` | Describe an initial-page read without coupling the contract to a framework or environment. |
| `FluxDevelopmentMetadata` | `const metadata: FluxDevelopmentMetadata = { initialPath: "/rooms", initialServerTrace: {} };` | Carry bounded, value-free development metadata separately from a page envelope. |
| `FluxInitialPageResult` | `const result: FluxInitialPageResult = { type: "not-found" };` | Let the host distinguish a missing page from a validated page result. |
| `FluxTransportProxyOptions` | `const options: FluxTransportProxyOptions = { backendUrl: "http://127.0.0.1:8000", fetch: globalThis.fetch };` | Supply explicit transport configuration rather than letting Core read adapter environment variables. |
| `createFluxTransportProxy` | `const proxy = createFluxTransportProxy({ backendUrl: "http://127.0.0.1:8000" });` | Create a framework-neutral HTTP proxy that preserves methods, queries, bodies, headers, manual redirects, cancellation, and streaming. |
| `fetchFluxInitialPage` | `const result = await fetchFluxInitialPage({ backendUrl: "http://127.0.0.1:8000", path: "/rooms" });` | Fetch and validate an initial envelope, follow safe canonical redirects, and classify a missing page for the host. |
| `removeFluxHopByHopHeaders` | `const responseHeaders = removeFluxHopByHopHeaders(upstream.headers);` | Clone request or response headers and drop all per-hop fields. |
| `selectFluxForwardHeaders` | `const forwarded = selectFluxForwardHeaders(request.headers, ["X-Tenant"]);` | Limit SSR forwarding to the four defaults and intentional additions after sanitation. |
<!-- core-server-api-examples:end -->

## Export-barrel decision

The source entry point retains its existing `export *` barrels. Replacing 156
known exports with one long hand-maintained statement would not improve runtime
behavior and could accidentally change type/value namespace exports. Instead,
CI compares the built declaration surface to the v0.8.1 snapshot and compares
that snapshot to the complete classification above. Adding, removing, or
renaming a barrel export therefore requires an intentional API review.

## Runtime neutrality

`@fluxfast/core` has no runtime dependencies and must remain independent of UI
frameworks. Its source and package metadata are checked to prevent imports or
dependencies on React, Next.js, Vue, Svelte, and Solid. Browser platform types
and APIs such as `fetch`, `AbortController`, `history`, and `ReadableStream`
remain allowed; adapters supply framework-specific rendering.

## Contract boundaries

This classification does not itself change the `fluxfast/1` protocol,
capability tokens, validation semantics, or mutation behavior. Dedicated v0.9
reviews document those contracts independently. See [architecture](architecture.md),
[versioning](versioning.md), [protocol](protocol.md), and [native client
validation](validation.md).
