# `@fluxfast/core` public API

FluxFast 0.9 freezes the framework-neutral runtime exported from the official
`@fluxfast/core` package root. The package intentionally has one public import
path:

```ts
import { FluxRouter, createValidator } from "@fluxfast/core";
```

Deep imports into `dist` or source files are internal. The package's ESM and
CommonJS entry points expose the same named API.

## Classification

A stable candidate is part of the ordinary application or adapter-author API.
An advanced stable candidate supports lower-level transport, cache, live,
protocol, or generated-validation integrations. Both classifications are
supported compatibility-sensitive API; advanced does not mean experimental.

The following inventory is machine-checked against the v0.8.1 declaration
snapshot. Every exported name must appear exactly once.

### Stable candidates

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

### Advanced stable candidates

<!-- core-api-advanced:start -->
```text
CAPABILITY_DEFERRED_RESOURCES
CAPABILITY_LIVE_RESOURCES
CachedPage
CompiledValidationPlan
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
FluxSseParser
FluxTransport
HEADER_CAPABILITIES
HEADER_CLIENT_ID
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

## Freeze boundaries

This classification does not itself change the `fluxfast/1` protocol,
capability tokens, validation semantics, or mutation behavior. Dedicated v0.9
reviews freeze those contracts independently. See [architecture](architecture.md),
[versioning](versioning.md), [protocol](protocol.md), and [native client
validation](validation.md).
