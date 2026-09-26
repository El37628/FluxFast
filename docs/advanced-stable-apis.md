# Advanced Stable APIs

Advanced Stable APIs are supported public APIs for infrastructure, framework,
transport, protocol, cache, live-resource, validation-plan, and generation
integrations. They receive the same FluxFast 1.x compatibility guarantee as
Stable APIs. "Advanced" means lower-level and easier to misuse; it does not
mean experimental.

Most application pages and components do not need these APIs. Start with the
[Stable APIs guide](stable-apis.md) if your goal is to define pages, load
resources, render data, navigate, or submit a form.

## When an Advanced Stable API is appropriate

Use this surface when at least one of these statements is true:

- you operate multiple FastAPI workers and need a distributed resource cache
  or live-event broker;
- you are integrating FluxFast with a nonstandard framework, native shell, or
  test transport;
- you must install or customize the server-only Next.js transport and health
  route handlers instead of using generated defaults;
- you are building code generation or validation tooling that consumes the
  documented plan/schema contracts;
- you are observing live/cache runtime metrics or handling their documented
  operational failures; or
- you are implementing protocol-compatible software and therefore need the
  frozen envelope, event, capability, and header contracts.

Do not choose an Advanced Stable API merely to avoid a higher-level helper.
The high-level API normally owns safety checks, lifecycle cleanup, request
headers, reconnect behavior, and generated-type integration that custom code
must otherwise reproduce.

## Advanced API families

### Python infrastructure and protocol

| Family | Representative APIs | Use it when... |
| --- | --- | --- |
| Resource cache backends | `ResourceCacheBackend`, `MemoryResourceCache`, `RedisResourceCache`, `CachedResource` | You are selecting or implementing where canonical resource values and tag indexes are cached. |
| Live brokers | `LiveBroker`, `MemoryLiveBroker`, `RedisLiveBroker`, `LiveCoordinator` | You are coordinating live invalidations and patches within or across workers. |
| Metrics | `LiveMetrics`, `RedisCacheMetrics` and their snapshots | You are exporting bounded operational counters to your monitoring system. |
| Protocol models | `PageEnvelope`, `MutationEnvelope`, `ErrorEnvelope`, resource and event models | You are implementing or testing a protocol boundary, not ordinary page code. |
| Capability and header constants | `CAPABILITY_*`, `HEADER_CAPABILITIES`, `PROTOCOL_VERSION`, `PROTOCOL_MEDIA_TYPE` | You are negotiating a compatible client/server feature or writing an adapter. |
| Live stream primitives | `derive_live_topic`, `encode_sse_event`, `iter_live_events`, `LiveSubscription` | You are implementing authorized live delivery below `FluxFast`. |
| Standalone router | `FluxRouter` | You need the FluxFast FastAPI router without the normal application integrator. |

### Core transport, live, and validation internals

| Family | Representative APIs | Use it when... |
| --- | --- | --- |
| Transport | `FluxTransport`, `FetchTransport`, `VisitTransportRequest`, `MutationTransportRequest` | A nonstandard host must provide page visits and mutations without the built-in Fetch transport. |
| Protocol assertions | `PageEnvelope`, `MutationEnvelope`, `assertPageEnvelope`, `assertMutationEnvelope` | An adapter receives unknown wire data and must reject incompatible payloads. |
| Live client integration | `LiveTransport`, `LiveManager`, `FetchSseLiveTransport`, live event types | A host must replace the browser SSE implementation or own live connection lifecycle. |
| Capability serialization | `FluxCapability`, `FLUX_CAPABILITIES`, capability helpers | An adapter constructs bounded negotiation headers. |
| Validation plans | `ValidationPlanDocument`, `CompiledValidationPlan`, node-plan types and limits | A generator or validator bridge produces or consumes FluxFast validation plans. |
| Runtime caches and history | `PageCache`, `PrefetchManager`, `HistoryManager` | An adapter replaces browser/runtime coordination rather than merely using hooks. |

### Next.js server and tooling integration

| Family | APIs | Use it when... |
| --- | --- | --- |
| Server transport route | `createFluxTransportHandler`, `FluxTransportHandlerOptions` | You manually own the private-backend proxy route or inject a test fetch implementation. |
| Health route | `createFluxHealthHandler`, `FluxHealthHandlerOptions` | You manually own same-origin health/readiness forwarding or need a deliberate timeout. |
| Route context | `FluxTransportRouteContext` | You are adapting a nonstandard route wrapper to the transport handler. |
| Registry inspection | `createPagesRegistrySnapshot`, `PagesRegistrySnapshot` | Tooling needs a read-only in-memory registry snapshot without writing files. |
| Destination resolution | `buildFluxPath`, `resolveInternalDestination` | Server tooling reconstructs a safe backend path or private rewrite destination. |
| Client context | `FluxContext`, `FluxContextValue` | A framework wrapper must bridge the provider context directly. Components should use hooks. |

## Every Advanced Stable API in one line

These are minimal declaration-and-use fragments, not standalone programs. They
assume surrounding integration values such as `request`, `cache`, `broker`,
`transport`, and generated validation plans already exist. Each row states the
operational responsibility the API introduces; read that column before copying
the line.
The three tables cover all 169 Advanced Stable exports currently frozen for
FluxFast 1.x: 51 Python exports, 107 Core exports, and 11 Next.js exports.

### Python Advanced Stable APIs

Import these names from `fluxfast`. They are primarily for infrastructure and
framework code rather than ordinary page handlers.

```python
from fluxfast import RedisLiveBroker, RedisResourceCache, ResourceCacheBackend
```

<!-- advanced-api-examples-python:start -->
| API | One-line declaration or use | What it actually does |
| --- | --- | --- |
| `CAPABILITY_DEFERRED_RESOURCES` | `supports_deferred = client_supports(request, CAPABILITY_DEFERRED_RESOURCES)` | Uses the frozen capability token to negotiate deferred-resource behavior. |
| `CAPABILITY_LIVE_RESOURCES` | `supports_live = client_supports(request, CAPABILITY_LIVE_RESOURCES)` | Uses the frozen capability token to negotiate live-resource behavior. |
| `CachedResource` | `entry = CachedResource(version="v1", value=rooms, expires_at=time.monotonic() + 30)` | Represents one backend cache value with version, monotonic expiry, and tags. |
| `DEFAULT_LIVE_HEARTBEAT_INTERVAL` | `heartbeat_seconds = DEFAULT_LIVE_HEARTBEAT_INTERVAL` | Reads the supported default delay between SSE heartbeat frames. |
| `DEFAULT_LIVE_MAX_CONNECTION_AGE` | `rotation_seconds = DEFAULT_LIVE_MAX_CONNECTION_AGE` | Reads the supported maximum live-stream lifetime before authorization is re-established. |
| `DEFAULT_LIVE_QUEUE_SIZE` | `queue_capacity = DEFAULT_LIVE_QUEUE_SIZE` | Reads the default bounded event queue size for each in-memory subscriber. |
| `DEFAULT_REDIS_CHANNEL_PREFIX` | `prefix = DEFAULT_REDIS_CHANNEL_PREFIX` | Reads the default Redis Pub/Sub channel namespace. |
| `DEFAULT_REDIS_MAX_MESSAGE_BYTES` | `message_limit = DEFAULT_REDIS_MAX_MESSAGE_BYTES` | Reads the maximum encoded Redis live-event payload accepted by default. |
| `DEFAULT_REDIS_MAX_VALUE_BYTES` | `value_limit = DEFAULT_REDIS_MAX_VALUE_BYTES` | Reads the maximum encoded Redis resource-cache entry accepted by default. |
| `DEFAULT_REDIS_SCAN_COUNT` | `scan_batch = DEFAULT_REDIS_SCAN_COUNT` | Reads the default bounded Redis `SCAN` batch hint used for namespace cleanup. |
| `ErrorDetail` | `detail = ErrorDetail(type="upstream", message="Service unavailable")` | Constructs the sanitized error object carried by a protocol error envelope. |
| `ErrorEnvelope` | `envelope = ErrorEnvelope(error=detail)` | Constructs a versioned top-level protocol error response. |
| `FluxRouter` | `router = FluxRouter()` | Creates the standalone FastAPI router for integrations that do not use `FluxFast(app)`. |
| `HEADER_CAPABILITIES` | `capabilities = request.headers.get(HEADER_CAPABILITIES)` | Reads the documented capability-negotiation header without hard-coding its spelling. |
| `LIVE_EVENT_NAME` | `assert event_name == LIVE_EVENT_NAME` | Uses the frozen SSE event name when producing or testing live frames. |
| `LIVE_HEARTBEAT` | `yield LIVE_HEARTBEAT` | Emits the canonical SSE comment frame that keeps an idle live connection active. |
| `LIVE_RESYNC_REASONS` | `assert reason in LIVE_RESYNC_REASONS` | Restricts resynchronization diagnostics to supported reason strings. |
| `LiveBroker` | `broker: LiveBroker = RedisLiveBroker.from_url(redis_url)` | Types the publish/subscribe boundary used by live coordination. |
| `LiveCoordinator` | `coordinator = LiveCoordinator(cache, broker)` | Authorizes scoped subscriptions, deletes cache entries, and publishes invalidations or patches. |
| `LiveEvent` | `event: LiveEvent = LiveInvalidateEvent(keys=["rooms"])` | Types the discriminated union of ready, invalidate, patch, and resync events. |
| `LiveInvalidateEvent` | `event = LiveInvalidateEvent(keys=["rooms"], originClientId=client_id)` | Constructs a validated event telling clients to reload selected resources. |
| `LiveMetrics` | `metrics = LiveMetrics()` | Creates process-local bounded live counters for an application metrics exporter. |
| `LiveMetricsSnapshot` | `snapshot: LiveMetricsSnapshot = metrics.snapshot()` | Reads an immutable point-in-time copy of every live counter. |
| `LivePatchEvent` | `event = LivePatchEvent(patches={"rooms": [append_item(created)]})` | Constructs a validated live patch event for immediate client updates. |
| `LiveReadyEvent` | `event = LiveReadyEvent(keys=["rooms"])` | Constructs the first event confirming the authorized live-key subscription. |
| `LiveResyncEvent` | `event = LiveResyncEvent(keys=["rooms"], reason="overflow")` | Tells the client to perform canonical reload after event delivery became uncertain. |
| `LiveResyncReason` | `reason: LiveResyncReason = "broker-recovery"` | Types one documented reason for forcing canonical live resynchronization. |
| `LiveSubscription` | `subscription = LiveSubscription(keys=("rooms",), topics=frozenset({topic}))` | Carries browser-visible authorized keys and opaque internal broker topics. |
| `MemoryLiveBroker` | `broker = MemoryLiveBroker(max_queue_size=DEFAULT_LIVE_QUEUE_SIZE)` | Provides bounded live fan-out inside one Python process. |
| `MemoryResourceCache` | `cache = MemoryResourceCache(max_entries=10_000)` | Provides async-safe TTL/LRU resource caching inside one Python process. |
| `MutationEnvelope` | `envelope = MutationEnvelope(mutation=MutationPayload(invalidate=["rooms"]))` | Constructs the versioned wire response for a successful mutation. |
| `MutationPayload` | `payload = MutationPayload(invalidate=["rooms"])` | Represents wire-level mutation patches, invalidations, and redirects. |
| `PROTOCOL_MEDIA_TYPE` | `response.headers["content-type"] = PROTOCOL_MEDIA_TYPE` | Uses the official FluxFast JSON media type at an adapter boundary. |
| `PROTOCOL_VERSION` | `assert envelope.protocol == PROTOCOL_VERSION` | Checks the independent browser wire-protocol identifier. |
| `PageDescriptor` | `page = PageDescriptor(component="rooms/index", url="/rooms")` | Constructs the wire-level selected component, canonical URL, and metadata. |
| `PageEnvelope` | `envelope = PageEnvelope(page=page, resources={})` | Constructs the complete versioned page payload returned to an adapter. |
| `ProtocolError` | `raise ProtocolError("Unsupported FluxFast payload")` | Reports a bounded protocol-contract violation. |
| `RedisCacheMetrics` | `metrics = RedisCacheMetrics()` | Creates low-cardinality process-local counters for Redis cache operations. |
| `RedisCacheMetricsSnapshot` | `snapshot: RedisCacheMetricsSnapshot = metrics.snapshot()` | Reads an immutable copy of Redis operation and payload counters. |
| `RedisLiveBroker` | `broker = RedisLiveBroker.from_url(redis_url, channel_prefix="fluxfast:prod:live:")` | Fans live events across processes or hosts through Redis Pub/Sub. |
| `RedisResourceCache` | `cache = RedisResourceCache.from_url(redis_url, namespace="hotel-prod")` | Shares bounded canonical resource values, TTLs, and tag indexes through Redis. |
| `ResourceCacheBackend` | `cache: ResourceCacheBackend = RedisResourceCache.from_url(redis_url, namespace="prod")` | Types a cache implementation that supports get, set, delete, tag invalidation, and clear. |
| `ResourceCacheError` | `except ResourceCacheError as error: fail_readiness(error)` | Handles the documented base failure for configured resource-cache operations. |
| `ResourceCacheSerializationError` | `except ResourceCacheSerializationError: reject_oversized_value()` | Handles a value that cannot be encoded safely within the cache contract. |
| `ResourceCacheUnavailableError` | `except ResourceCacheUnavailableError: mark_dependency_unready()` | Handles a Redis/backend availability failure without unsafe local fallback. |
| `ResourceErrorDetail` | `detail = ResourceErrorDetail(type="timeout", message="Resource unavailable")` | Constructs sanitized per-resource error data for partial page failure. |
| `ResourceWireRecord` | `record = ResourceWireRecord(version="rooms-v1", value=rooms)` | Pairs a canonical resource value with its opaque browser version. |
| `client_supports` | `if client_supports(request, CAPABILITY_LIVE_RESOURCES): enable_live()` | Safely checks the bounded capability header parsed from a request. |
| `derive_live_topic` | `topic = derive_live_topic(scope.tenant(hotel.id), "rooms")` | Derives a deterministic opaque broker topic without exposing scope identity. |
| `encode_sse_event` | `frame: bytes = encode_sse_event(LiveReadyEvent(keys=["rooms"]))` | Serializes one validated event into the canonical named SSE frame. |
| `iter_live_events` | `stream = iter_live_events(coordinator, subscription)` | Produces ready, broker-event, heartbeat, and rotation frames for an SSE response. |
<!-- advanced-api-examples-python:end -->

### `@fluxfast/core` Advanced Stable APIs

Import these names from `@fluxfast/core`. The examples deliberately expose the
lower-level lifecycle or wire responsibility that ordinary hooks hide.

```ts
import type { FluxTransport, PageEnvelope } from "@fluxfast/core";
```

<!-- advanced-api-examples-core:start -->
| API | One-line declaration or use | What it actually does |
| --- | --- | --- |
| `CAPABILITY_DEFERRED_RESOURCES` | `const capability = CAPABILITY_DEFERRED_RESOURCES;` | Names deferred-resource negotiation without duplicating its wire token. |
| `CAPABILITY_LIVE_RESOURCES` | `const capability = CAPABILITY_LIVE_RESOURCES;` | Names live-resource negotiation without duplicating its wire token. |
| `CachedPage` | `const cached: CachedPage = pageCache.getValid("/rooms", resourceStore)!;` | Represents a cached page shell and the resource versions/manifest that keep it valid. |
| `CompiledValidationPlan` | `const compiled: CompiledValidationPlan = compileValidationPlan(plan);` | Holds a checked plan, definitions, regexes, and normalized runtime limits. |
| `DEFAULT_LIVE_RECONNECT_INITIAL_DELAY_MS` | `const firstDelay = DEFAULT_LIVE_RECONNECT_INITIAL_DELAY_MS;` | Reads the first live reconnect backoff delay. |
| `DEFAULT_LIVE_RECONNECT_JITTER` | `const jitter = DEFAULT_LIVE_RECONNECT_JITTER;` | Reads the default randomized reconnect-delay fraction. |
| `DEFAULT_LIVE_RECONNECT_MAX_DELAY_MS` | `const maxDelay = DEFAULT_LIVE_RECONNECT_MAX_DELAY_MS;` | Reads the upper bound for live reconnect backoff. |
| `DEFAULT_VALIDATION_MAX_DEPTH` | `const maxDepth = DEFAULT_VALIDATION_MAX_DEPTH;` | Reads the default nested-value traversal limit. |
| `DEFAULT_VALIDATION_MAX_ISSUES` | `const maxIssues = DEFAULT_VALIDATION_MAX_ISSUES;` | Reads the default maximum retained issues per validation. |
| `DEFAULT_VALIDATION_MAX_OPERATIONS` | `const maxOperations = DEFAULT_VALIDATION_MAX_OPERATIONS;` | Reads the default evaluator work budget. |
| `DEFAULT_VALIDATION_MAX_PROPERTIES` | `const maxProperties = DEFAULT_VALIDATION_MAX_PROPERTIES;` | Reads the default bound on compared object properties or literal items. |
| `ErrorDetail` | `const detail: ErrorDetail = { type: "upstream", message: "Unavailable" };` | Types sanitized top-level protocol error data. |
| `ErrorEnvelope` | `const envelope: ErrorEnvelope = { protocol: "fluxfast/1", error: detail };` | Types a complete versioned protocol error response. |
| `FLUX_CAPABILITIES` | `const advertised = FLUX_CAPABILITIES.join(",");` | Reads the complete supported capability list in canonical order. |
| `FetchSseLiveTransport` | `const liveTransport = new FetchSseLiveTransport("https://app.example.com");` | Opens validated, abortable, credentialed SSE streams with standard FluxFast headers. |
| `FetchTransport` | `const transport = new FetchTransport("https://app.example.com");` | Implements visits and mutations with Fetch, protocol validation, and structured errors. |
| `FluxCapability` | `const capability: FluxCapability = CAPABILITY_LIVE_RESOURCES;` | Restricts an adapter capability value to the supported token union. |
| `FluxSseParser` | `const events = new FluxSseParser().push(chunk);` | Incrementally parses arbitrarily chunked SSE bytes into validated live events. |
| `FluxTransport` | `const transport: FluxTransport = { visit, mutate };` | Defines the framework-neutral visit and mutation boundary consumed by `FluxRouter`. |
| `HEADER_CAPABILITIES` | `headers[HEADER_CAPABILITIES] = serializeCapabilities();` | Writes the documented capability-negotiation request header. |
| `HEADER_CLIENT_ID` | `headers[HEADER_CLIENT_ID] = clientId;` | Writes the router identity used to suppress an originating tab's echoed event. |
| `HEADER_LIVE` | `headers[HEADER_LIVE] = "1";` | Marks a request as a live SSE stream request. |
| `HEADER_LIVE_KEYS` | `headers[HEADER_LIVE_KEYS] = serializeLiveKeys(["rooms"]);` | Writes the bounded authorized logical-key selection for a live stream. |
| `HistoryManager` | `const history = new HistoryManager();` | Wraps browser push, replace, and popstate lifecycle behind a framework-neutral object. |
| `HistoryOptions` | `const historyOptions: HistoryOptions = { replace: true };` | Types a history write that replaces rather than pushes an entry. |
| `LIVE_EVENT_NAME` | `if (eventName !== LIVE_EVENT_NAME) rejectFrame();` | Checks the one supported SSE event name. |
| `LIVE_RESYNC_REASONS` | `const allowed = LIVE_RESYNC_REASONS.includes(reason);` | Checks a resync reason against the supported readonly list. |
| `LiveConnection` | `const connection: LiveConnection = liveTransport.connect(options);` | Represents one abortable async iterable of validated live events. |
| `LiveConnectionCloseEvent` | `const onClose = (event: LiveConnectionCloseEvent) => trace(event.reason);` | Types a close diagnostic including reason and reconnect decision. |
| `LiveConnectionEvent` | `const onOpen = (event: LiveConnectionEvent) => count(event.keyCount);` | Types live connection diagnostics shared by start/open/reconnect. |
| `LiveConnectionOptions` | `const options: LiveConnectionOptions = { url: "/rooms", keys: ["rooms"], clientId };` | Configures the URL, keys, identity, signal, and headers for one live connection. |
| `LiveConnectionStatus` | `const status: LiveConnectionStatus = "reconnecting";` | Restricts live lifecycle state to the documented status union. |
| `LiveEvent` | `const event: LiveEvent = { protocol: "fluxfast/1", type: "ready", keys: ["rooms"] };` | Types the discriminated union of live ready, invalidation, patch, and resync events. |
| `LiveInvalidateEvent` | `const event: LiveInvalidateEvent = { protocol: "fluxfast/1", type: "invalidate", keys: ["rooms"] };` | Types a canonical-reload notification for selected resources. |
| `LiveManager` | `const manager = new LiveManager({ transport: liveTransport });` | Owns one reconnecting live stream, network state, subscribers, and diagnostics. |
| `LiveManagerDiagnostic` | `const record = (event: LiveManagerDiagnostic) => telemetry.emit(event.type);` | Types bounded lifecycle diagnostics without leaking resource names. |
| `LiveManagerOptions` | `const options: LiveManagerOptions = { reconnectMaxDelayMs: 10_000 };` | Configures transport, identity, callbacks, network adapter, timing, and jitter. |
| `LiveManifest` | `const manifest: LiveManifest = { url: "/rooms", keys: ["rooms"] };` | Describes the current authorized page URL and live resource keys. |
| `LiveNetworkAdapter` | `const network: LiveNetworkAdapter = { isOnline, subscribe };` | Abstracts online/offline observation for non-browser hosts and tests. |
| `LivePatchEvent` | `const event: LivePatchEvent = { protocol: "fluxfast/1", type: "patch", patches };` | Types immediate resource patches delivered over the live stream. |
| `LiveReadyEvent` | `const event: LiveReadyEvent = { protocol: "fluxfast/1", type: "ready", keys: ["rooms"] };` | Types the first event confirming a live subscription. |
| `LiveResyncEvent` | `const event: LiveResyncEvent = { protocol: "fluxfast/1", type: "resync", keys: ["rooms"], reason: "overflow" };` | Types a request for canonical resource reloading. |
| `LiveResyncReason` | `const reason: LiveResyncReason = "reconnect";` | Restricts resync diagnostics to supported reason strings. |
| `LiveStatusSnapshot` | `const snapshot: LiveStatusSnapshot = manager.getSnapshot();` | Reads stable live status, connectivity, attempts, and last-event time. |
| `LiveTransport` | `const transport: LiveTransport = createFetchSseLiveTransport();` | Defines the connection factory consumed by `LiveManager`. |
| `MAX_LIVE_CLIENT_ID_LENGTH` | `if (clientId.length > MAX_LIVE_CLIENT_ID_LENGTH) rejectClient();` | Applies the frozen printable client-identity bound. |
| `MAX_LIVE_EVENT_BYTES` | `if (frame.byteLength > MAX_LIVE_EVENT_BYTES) rejectFrame();` | Applies the maximum SSE event-frame size. |
| `MAX_LIVE_EVENT_KEYS` | `const selected = keys.slice(0, MAX_LIVE_EVENT_KEYS);` | Applies the maximum keys carried by one live event. |
| `MAX_LIVE_KEYS_HEADER_BYTES` | `if (bytes > MAX_LIVE_KEYS_HEADER_BYTES) rejectHeader();` | Applies the maximum serialized live-key header size. |
| `MAX_LIVE_RESOURCE_KEY_LENGTH` | `if (key.length > MAX_LIVE_RESOURCE_KEY_LENGTH) rejectKey();` | Applies the maximum logical resource-key length in live metadata. |
| `MutationEnvelope` | `const envelope: MutationEnvelope = await transport.mutate(request);` | Types the complete versioned mutation response. |
| `MutationPayload` | `const payload: MutationPayload = { invalidate: ["rooms"] };` | Types wire-level patches, invalidations, and redirects. |
| `MutationTransportRequest` | `const request: MutationTransportRequest = { url: "/rooms/102", method: "PATCH", data };` | Configures one transport mutation including identity, headers, signal, and body. |
| `PROTOCOL_MEDIA_TYPE` | `headers.accept = PROTOCOL_MEDIA_TYPE;` | Uses the official JSON media type for protocol requests. |
| `PROTOCOL_VERSION` | `if (input.protocol !== PROTOCOL_VERSION) rejectVersion();` | Checks the independent browser protocol identifier. |
| `PageCache` | `const pageCache = new PageCache(32);` | Caches bounded page shells while resource values remain in `ResourceStore`. |
| `PageCacheManifest` | `const manifest: PageCacheManifest = { resourceKeys: ["rooms"], pendingDeferred: [] };` | Records the complete resource, deferred, and live membership required to validate a cached page. |
| `PageDescriptor` | `const page: PageDescriptor = { component: "rooms/index", url: "/rooms" };` | Types the selected component, canonical URL, and optional metadata. |
| `PageEnvelope` | `const envelope: PageEnvelope = await transport.visit(request);` | Types the complete versioned page payload applied by the runtime. |
| `PopStateCallback` | `const onPop: PopStateCallback = url => router.visit(url, { replace: true });` | Types browser back/forward handling installed on `HistoryManager`. |
| `PrefetchEntry` | `const prefetched: PrefetchEntry = { envelope, expiresAt, basedOnVersions };` | Represents a short-lived prefetched envelope and the versions that make it safe. |
| `PrefetchManager` | `const prefetch = new PrefetchManager(10_000);` | Deduplicates in-flight prefetches and caches version-safe results with bounded eviction. |
| `ProtocolVersion` | `const version: ProtocolVersion = "fluxfast/1";` | Restricts a protocol version value to the supported wire identifier. |
| `ResourceErrorDetail` | `const detail: ResourceErrorDetail = { type: "timeout", message: "Unavailable" };` | Types sanitized partial resource failure data. |
| `ResourceWireRecord` | `const record: ResourceWireRecord<Room[]> = { version: "v1", value: rooms };` | Pairs a browser resource value with its opaque version. |
| `VALIDATION_FORMATS` | `const formats = [...VALIDATION_FORMATS];` | Reads every supported native string-format validator. |
| `VALIDATION_PATTERN_MAX_LENGTH` | `if (pattern.length > VALIDATION_PATTERN_MAX_LENGTH) rejectPattern();` | Applies the maximum accepted regex source length. |
| `ValidationAnyPlan` | `const plan: ValidationAnyPlan = { kind: "any" };` | Declares a plan node that accepts any value within evaluator bounds. |
| `ValidationArrayPlan` | `const plan: ValidationArrayPlan = { kind: "array", items: { kind: "string" } };` | Declares homogeneous or prefix-item array validation. |
| `ValidationBooleanPlan` | `const plan: ValidationBooleanPlan = { kind: "boolean" };` | Declares boolean validation. |
| `ValidationEnumPlan` | `const plan: ValidationEnumPlan = { kind: "enum", values: ["open", "closed"] };` | Declares membership in a bounded literal set. |
| `ValidationFormat` | `const format: ValidationFormat = "email";` | Restricts a format name to the supported native format union. |
| `ValidationIntersectionPlan` | `const plan: ValidationIntersectionPlan = { kind: "intersection", allOf: [{ kind: "object" }] };` | Requires a value to satisfy every child plan. |
| `ValidationLiteralPlan` | `const plan: ValidationLiteralPlan = { kind: "literal", value: "open" };` | Requires exact equality with one JSON-compatible literal. |
| `ValidationNeverPlan` | `const plan: ValidationNeverPlan = { kind: "never" };` | Declares a node that rejects every value. |
| `ValidationNode` | `const node: ValidationNode = { kind: "string", minLength: 1 };` | Types any concrete non-boolean validation-plan node. |
| `ValidationNullPlan` | `const plan: ValidationNullPlan = { kind: "null" };` | Requires an explicit `null` value. |
| `ValidationNumberPlan` | `const plan: ValidationNumberPlan = { kind: "integer", minimum: 1 };` | Declares bounded number or integer validation. |
| `ValidationObjectPlan` | `const plan: ValidationObjectPlan = { kind: "object", required: ["name"] };` | Declares object properties, required keys, and additional-property behavior. |
| `ValidationOneOfPlan` | `const plan: ValidationOneOfPlan = { kind: "oneOf", anyOf: [{ kind: "string" }, { kind: "number" }] };` | Requires exactly one child plan to match. |
| `ValidationPlan` | `const plan: ValidationPlan = { kind: "string", minLength: 1 };` | Types any supported node or boolean validation plan. |
| `ValidationPlanDocument` | `const document: ValidationPlanDocument = { root: plan, definitions: {} };` | Packages a root plan with reusable named definitions. |
| `ValidationRefPlan` | `const plan: ValidationRefPlan = { kind: "ref", name: "Room" };` | Refers to a named local or document definition, including recursive plans. |
| `ValidationReferenceTarget` | `const target: ValidationReferenceTarget = { name: "Room" };` | Types the mutually exclusive `name` or `ref` reference selector. |
| `ValidationStringPlan` | `const plan: ValidationStringPlan = { kind: "string", format: "email" };` | Declares length, pattern, or supported format checks for strings. |
| `ValidationTuplePlan` | `const plan: ValidationTuplePlan = { kind: "tuple", items: [{ kind: "string" }] };` | Declares fixed-position items and optional rest behavior. |
| `ValidationUnionPlan` | `const plan: ValidationUnionPlan = { kind: "union", anyOf: [{ kind: "string" }, { kind: "null" }] };` | Accepts a value matching at least one child plan. |
| `VisitTransportRequest` | `const request: VisitTransportRequest = { url: "/rooms", visitId: "visit_1" };` | Configures one visit with known versions, partial keys, headers, and cancellation. |
| `assertClientId` | `assertClientId(clientId);` | Accepts `undefined` or validates that a supplied client identity is printable ASCII within the frozen length bound. |
| `assertLiveEvent` | `assertLiveEvent(decoded);` | Validates unknown decoded data and narrows it to `LiveEvent`. |
| `assertMutationEnvelope` | `assertMutationEnvelope(decoded);` | Validates unknown data and narrows it to a compatible mutation envelope. |
| `assertPageEnvelope` | `assertPageEnvelope(decoded);` | Validates unknown data and narrows it to a compatible page envelope. |
| `compileValidationPlan` | `const compiled = compileValidationPlan(document, { maxIssues: 20 });` | Checks a static plan once, resolves definitions, compiles patterns, and normalizes limits. |
| `createClientId` | `const clientId = createClientId();` | Creates one opaque Web-Crypto identity for a router/live-manager lifetime. |
| `createFetchSseLiveTransport` | `const liveTransport = createFetchSseLiveTransport("https://app.example.com");` | Creates the standard Fetch/SSE live transport. |
| `createFetchTransport` | `const transport = createFetchTransport("https://app.example.com");` | Creates the standard Fetch visit/mutation transport. |
| `createLiveManager` | `const manager = createLiveManager({ transport: liveTransport });` | Creates a live lifecycle manager through the factory API. |
| `encodeKnownVersions` | `const header = encodeKnownVersions({ rooms: "rooms-v1" });` | Produces bounded base64url known-version metadata or omits an unsafe optimization. |
| `evaluateValidationPlan` | `const result = evaluateValidationPlan<RoomInput>(compiled, input);` | Evaluates a previously compiled plan without recompiling it. |
| `isSupportedValidationFormat` | `if (isSupportedValidationFormat(format)) validateValidationFormat(value, format);` | Narrows an arbitrary string to a supported format name. |
| `isValidationPlanDocument` | `const root = isValidationPlanDocument(input) ? input.root : input;` | Distinguishes a document wrapper from a bare plan. |
| `prepareValidationPlan` | `const compiled = prepareValidationPlan(document, { maxDepth: 32 });` | Exposes the prepared plan representation used by generated or advanced integrations. |
| `serializeCapabilities` | `headers[HEADER_CAPABILITIES] = serializeCapabilities();` | Serializes supported capabilities into the canonical bounded header value. |
| `serializeLiveKeys` | `headers[HEADER_LIVE_KEYS] = serializeLiveKeys(["rooms", "summary"]);` | Deduplicates, sorts, validates, bounds, and serializes live resource keys. |
| `validateValidationFormat` | `const valid = validateValidationFormat("dev@example.com", "email");` | Runs one dependency-free supported string-format check. |
| `validateWithPlan` | `const result = validateWithPlan<RoomInput>(document, input);` | Compiles and evaluates a plan in one convenience call. |
| `validationPatternError` | `const diagnostic = validationPatternError("^[a-z]+$");` | Explains why a regex is outside the portable bounded pattern subset. |
<!-- advanced-api-examples-core:end -->

### `@fluxfast/next` Advanced Stable APIs

Import context primitives from the root/client entry and server helpers from
`@fluxfast/next/server`; registry snapshots belong to `/generate`.

```ts
import { createFluxHealthHandler, createFluxTransportHandler } from "@fluxfast/next/server";
```

<!-- advanced-api-examples-next:start -->
| API | One-line declaration or use | What it actually does |
| --- | --- | --- |
| `FluxContext` | `return <FluxContext.Provider value={{ router, registry }}>{children}</FluxContext.Provider>;` | Provides the low-level React context normally owned by `FluxProvider`. |
| `FluxContextValue` | `const value: FluxContextValue = { router, registry };` | Types the router and component registry carried by the client context. |
| `FluxHealthHandlerOptions` | `const options: FluxHealthHandlerOptions = { backendUrl, timeoutMs: 2_000 };` | Configures private backend resolution and timeout for health/readiness forwarding. |
| `FluxTransportHandlerOptions` | `const options: FluxTransportHandlerOptions = { backendUrl, fetch: tracedFetch };` | Configures backend resolution or an injected Fetch implementation for the transport route. |
| `FluxTransportRouteContext` | `const context: FluxTransportRouteContext = { params: { path: ["rooms", "102"] } };` | Types optional catch-all route parameters passed to the transport handler. |
| `PagesRegistrySnapshot` | `const snapshot: PagesRegistrySnapshot = createPagesRegistrySnapshot();` | Holds generated registry content, files, identifiers, and resolved paths without writing. |
| `buildFluxPath` | `const path = buildFluxPath(["rooms", "102"], { tab: "details" });` | Safely reconstructs an origin-relative backend path from Next params and search values. |
| `createFluxHealthHandler` | `export const GET = createFluxHealthHandler({ timeoutMs: 2_000 });` | Creates a bounded same-origin health/readiness proxy that hides private backend details. |
| `createFluxTransportHandler` | `const transport = createFluxTransportHandler({ backendUrl });` | Creates the header-gated streaming server proxy used by generated production routes. |
| `createPagesRegistrySnapshot` | `const snapshot = createPagesRegistrySnapshot({ pagesDir: "src/flux-pages" });` | Scans page modules and returns deterministic registry output without writing files. |
| `resolveInternalDestination` | `const destination = resolveInternalDestination("../summary", window.location.href);` | Resolves only same-origin navigations and returns `null` for external or invalid destinations. |
<!-- advanced-api-examples-next:end -->

## Example: multi-worker Redis cache and live broker

The default memory cache and broker are process-local. A deployment with
multiple workers uses the Advanced Stable Redis implementations so every
worker sees the same cached values and live signals.

Install the optional dependency:

```bash
python -m pip install "fluxfast[redis]"
```

Configure both components once per FastAPI process:

```python
import os

from fastapi import FastAPI
from fluxfast import FluxFast, RedisLiveBroker, RedisResourceCache


redis_url = os.environ["REDIS_URL"]
namespace = os.environ.get("FLUXFAST_NAMESPACE", "hotel-production")

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

Configuration input:

```dotenv
REDIS_URL=redis://redis.internal:6379/0
FLUXFAST_NAMESPACE=hotel-production
```

Once Redis is reachable and the application lifespan has started, the backend
readiness endpoint returns:

```http
HTTP/1.1 200 OK
Content-Type: application/json

{"status":"ready"}
```

Every worker in one deployment must use the same Redis database, cache
`namespace`, and broker `channel_prefix`. Different applications,
environments, or incompatible rollouts need different values. These names
provide operational isolation, not authorization; Redis credentials and
network policy remain infrastructure responsibilities.

Use both components when you need shared positive-TTL live resources. The
cache stores canonical values; the broker carries ephemeral events. Neither
replaces the other or the primary database. See
[Distributed Resource Coherence](distributed-cache.md) for failure behavior,
limits, and topology choices.

## Example: manually own the Next.js server handlers

`fluxfast init` normally generates these routes. Use the Advanced Stable
handlers directly only when your application deliberately owns the files or
needs explicit server-only options.

Transport route at
`src/app/_fluxfast/transport/[[...path]]/route.ts`:

```ts
import { createFluxTransportHandler } from "@fluxfast/next/server";

export const dynamic = "force-dynamic";

const transport = createFluxTransportHandler({
  backendUrl: process.env.FLUXFAST_BACKEND_URL,
});

export const GET = transport;
export const HEAD = transport;
export const POST = transport;
export const PUT = transport;
export const PATCH = transport;
export const DELETE = transport;
```

Health route at `src/app/_fluxfast/[probe]/route.ts`:

```ts
import { createFluxHealthHandler } from "@fluxfast/next/server";

export const dynamic = "force-dynamic";

export const GET = createFluxHealthHandler({
  backendUrl: process.env.FLUXFAST_BACKEND_URL,
  timeoutMs: 2_000,
});
```

Input:

```http
GET /_fluxfast/readyz HTTP/1.1
Host: app.example.com
```

Successful output:

```http
HTTP/1.1 200 OK
Cache-Control: no-store
Content-Type: application/json; charset=utf-8

{"status":"ready"}
```

If the private backend is unavailable, times out, or returns a malformed
payload, the public handler returns the bounded non-sensitive response:

```http
HTTP/1.1 503 Service Unavailable
Cache-Control: no-store
Content-Type: application/json; charset=utf-8

{"status":"not_ready"}
```

The transport handler accepts only requests carrying FluxFast's private
transport marker, removes hop-by-hop headers, keeps response bodies streaming,
and does not expose the backend URL to browser code. A custom wrapper must
preserve those properties.

## Example: provide a framework-neutral Core transport

Adapter authors can replace browser Fetch by implementing `FluxTransport`.
This small in-memory transport is useful for a non-browser host or deterministic
adapter test:

```ts
import {
  createFluxRuntime,
  type FluxTransport,
} from "@fluxfast/core";

const transport: FluxTransport = {
  async visit(request) {
    return {
      protocol: "fluxfast/1",
      page: {
        component: "reports/index",
        url: request.url,
      },
      resources: {
        summary: {
          version: "summary-v1",
          value: { total: 12 },
        },
      },
    };
  },

  async mutate() {
    return {
      protocol: "fluxfast/1",
      mutation: { invalidate: ["summary"] },
    };
  },
};

const runtime = createFluxRuntime({
  transport,
  deferHistory: true,
});

await runtime.visit("/reports", { preserveState: true });

console.log({
  page: runtime.pageStore.getSnapshot(),
  summary: runtime.resourceStore.getSnapshot("summary"),
});
```

Output:

```json
{
  "page": {
    "component": "reports/index",
    "url": "/reports",
    "meta": {}
  },
  "summary": {
    "total": 12
  }
}
```

A production transport must also propagate abort signals, return structured
mutation errors, enforce protocol compatibility, preserve safe redirect
semantics, and avoid applying stale responses. Prefer `FetchTransport` unless
the host genuinely cannot use it.

## Example: inspect protocol data safely

Protocol models and assertions are appropriate at trust boundaries. Validate
unknown JSON before an adapter treats it as a page envelope:

```ts
import {
  assertPageEnvelope,
  type PageEnvelope,
} from "@fluxfast/core";

export function readPageEnvelope(input: unknown): PageEnvelope {
  assertPageEnvelope(input);
  return input;
}
```

Valid input:

```json
{
  "protocol": "fluxfast/1",
  "page": { "component": "home/index", "url": "/" },
  "resources": {}
}
```

An incompatible protocol identifier throws `VersionMismatchError`; a malformed
page or resource record throws `ProtocolError`. Application components should
not parse these envelopes themselves—the adapter already validates them.

## Responsibilities that move to custom integrations

When you use Advanced Stable APIs, your integration owns more than the call
signature:

- **Lifecycle:** close owned Redis clients, abort superseded requests, stop
  subscriptions, and release listeners during shutdown or logout.
- **Security:** preserve FastAPI authorization, scope isolation, bounded
  headers/payloads, non-sensitive errors, and the one-origin browser model.
- **Correctness:** validate protocol data, ignore or reject unsupported
  capabilities safely, and prevent older responses from overwriting newer
  state.
- **Operations:** expose readiness honestly; never hide a distributed-cache
  failure behind an incoherent process-local fallback.
- **Compatibility:** import only official entry points and test against packed
  published packages rather than source or `dist` deep imports.

## APIs normal application code should usually avoid

| Instead of... | Normally use... |
| --- | --- |
| Constructing `PageEnvelope` in a React component | `usePage()` and `useResource()` |
| Building FluxFast request headers manually | `@fluxfast/next` navigation and mutation APIs |
| Reading `FluxContext` directly | `useFlux()`, `useRouter()`, and resource hooks |
| Creating transport and health handlers by hand | `fluxfast init` |
| Constructing validation-plan nodes | Generated validators or `createValidator()` |
| Calling live topic/SSE helpers in a page route | `resource(..., live=True)` and scoped invalidation |
| Using `MemoryResourceCache` as a distributed cache | `RedisResourceCache` or a deliberate custom backend |

## Complete inventories and specifications

- [Python public API](python-api.md#export-classification)
- [`@fluxfast/core` public API](core-api.md#classification)
- [`@fluxfast/next` public API](next-api.md#classification)
- [Wire protocol](protocol.md)
- [Distributed cache](distributed-cache.md)
- [Live deployment](live-deployment.md)
- [Validation plans and client validation](validation.md)
- [Stability contract](stability.md)
