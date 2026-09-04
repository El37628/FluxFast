# Changelog

Notable user-facing changes are recorded in this file. FluxFast follows
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.8.0] - 2026-09-04

### Added

- Server-owned general application contracts through `FluxFast.define_type()`,
  supporting both serialization and validation modes independent of resource
  loaders or page routes.
- The `fluxfast-schema/2` developer manifest specification featuring explicit
  application `types`, reusable mutation input schemas, and deterministic
  SHA-256 fingerprinting.
- Reusable TypeScript interfaces for mutation request bodies (e.g.,
  `CreateRoomBody`) generated into `types.generated.ts` and consumed by typed
  mutation helpers.
- Unified Type Graph compiler that globally tracks and deduplicates schema
  definitions, resolves referenced `$defs`, detects name collisions, and gives
  explicit contract names precedence over inferred model titles.
- Framework-neutral, zero-dependency runtime validation engine in
  `@fluxfast/core` exposing `FluxValidator<T>`, `ValidationResult<T>`,
  `ValidationIssue`, and `formatValidationPath`.
- Code generation of `@/.fluxfast/validators.generated.ts` containing pure,
  tree-shakeable validators for registered type contracts, resources, and
  mutation bodies.
- Synchronous validator composition via `refineValidator()`, allowing
  application-specific checks after schema validation succeeds without mutating
  values.
- Pre-submit form validation in `@fluxfast/next`'s `useForm` hook with the
  `validator` option, exposing synchronous `validate()`, structured `issues`,
  and canonical `errorMap` dictionaries while preventing network requests for
  locally invalid submissions.
- CLI drift detection (`fluxfast types --check`, `fluxfast generate --check`)
  and expanded `fluxfast doctor` diagnostics for schema/2 manifests, contract
  naming collisions, and validator compilation warnings.
- Controlled code-generation, runtime, validation-plan, and bundle-size
  benchmark gates with tree-shakeable ESM/CJS exports.
- Dedicated architectural decision record (`ADR-0008`), [Migration
  Guide](docs/migration.md), [Release Notes](docs/releases/v0.8.0.md), and guides
  for [General Application Contracts](docs/contracts.md) and [Native Client
  Validation](docs/validation.md).

### Changed

- The code generator now compiles all contracts through a unified schema graph
  while preserving existing imports from `@/.fluxfast/types.generated`
  (`resourceKeys`, `FluxResourceMap`).
- `@fluxfast/next` 0.8 CLI seamlessly consumes both `fluxfast-schema/2` and
  legacy `fluxfast-schema/1` manifests without modifying generated files.
- Dual ESM and CommonJS exports for `@fluxfast/core` and `@fluxfast/next` allow
  tree-shaking of unused validation plans in modern bundlers while preserving
  compatibility with Next.js server imports.
- Release compatibility gates now test adjacent `0.8` and `0.7` mixed-package
  directions across both Python and JavaScript runtimes.

### Fixed

- Unsupported schema keywords now produce explicit compilation diagnostics
  instead of being silently dropped.
- Recursive JSON pointer references in validation plans now resolve cleanly
  without triggering infinite loops or maximum call stack errors.
- Server import compatibility for `@fluxfast/next/server` under Next.js module
  resolution without explicit extensions.

### Security

- Native validator evaluation enforces defensive resource bounds (`maxDepth`,
  `maxOperations`, `maxIssues`, `maxProperties`) to protect against CPU and
  memory starvation from hostile inputs.
- Evaluator includes strict prototype pollution protection, safely ignoring
  `__proto__`, `constructor`, and `prototype` keys during object validation.
- Cyclic and hostile JavaScript objects are safely detected and rejected without
  unhandled exceptions.
- Client validation remains strictly a UX enhancement; FastAPI and Pydantic
  remain the authoritative validation boundary for all security and business
  invariants.

## [0.7.0] - 2026-09-02

### Added

- `fluxfast build` for read-only production validation and local package-manager
  builds, plus `fluxfast start` for a foreground production service that
  supervises private FastAPI/Uvicorn and public Next.js processes behind one
  browser origin.
- Explicit production configuration for public and backend bindings, Uvicorn
  workers, startup and shutdown timeouts, ordered readiness, graceful
  SIGTERM/SIGINT handling, sibling shutdown on child failure, and meaningful
  exit statuses.
- Minimal `/_fluxfast/healthz` and `/_fluxfast/readyz` endpoints routed through
  the public Next.js port, along with `fluxfast doctor --production --strict`
  diagnostics for build, network, package-version, worker, Redis, and container
  risks.
- A single-service OCI production image and Redis Compose topology tested with
  Docker, rootless Podman, Docker Compose, and Podman Compose as a non-root,
  read-only runtime exposing only port `3000`.
- Production browser, three-worker Redis, child-failure, repeated lifecycle,
  clean artifact-consumer, registry-consumer, container, and observational
  startup/shutdown benchmark coverage.

### Changed

- The Next.js adapter now forwards production health probes and uses the
  supervisor-provided private backend URL, so normal production applications
  require neither a browser-visible backend port nor CORS configuration.
- Existing npm, pnpm, Yarn, and Bun projects can keep their installed package
  manager, and existing manual `uvicorn` plus `next start` deployments remain
  supported; the `fluxfast/1` and `fluxfast-schema/1` protocols are unchanged.
- Release publication now waits for the full Python/JavaScript matrix,
  production integration, Docker and rootless Podman, built-package consumers,
  registry-backed production use, and both `0.7`/`0.6` package directions
  before creating the GitHub Release.

### Fixed

- Development-mode redirects to unknown FluxFast pages now preserve the 404
  boundary without producing React Server Components' negative
  `performance.measure()` timestamp error.

### Security

- FastAPI binds to loopback by default; child commands use argument arrays,
  package-manager execution has no implicit download fallback, and production
  startup neither installs packages nor modifies source or generated files.
- Production diagnostics and Redis or process failures redact credentials and
  secret environment values; health and readiness bodies remain minimal and
  omit paths, ports, process IDs, dependencies, and other runtime details.
- Container verification rejects root users, privileged mode, socket mounts,
  extra exposed or published ports, writable root filesystems, leaked secrets,
  orphaned processes, and unsuccessful PID 1 shutdown.

## [0.6.0] - 2026-09-01

### Added

- Server-owned generic `ResourceContract` declarations through
  `FluxFast.define_resource()`, backed by Pydantic serialization schemas and
  runtime validation of blocking, deferred, live, cached, and Redis-backed
  resource values.
- The independent `fluxfast-schema/1` developer manifest with deterministic
  fingerprints plus offline `fluxfast schema` export and drift checking.
- Generated TypeScript resource models and key constants, typed page-route
  builders, typed JSON mutation helpers, and inferred `useResource`,
  `useResourceState`, and `useDeferredResource` values.
- Schema-aware `fluxfast generate`, read-only `generate --check`, type-aware
  `fluxfast doctor` diagnostics, and the one-command `fluxfast types` workflow
  for npm, pnpm, Yarn, and Bun projects.
- Advanced Pydantic schema, recursive model, generated inference, real browser,
  packed consumer, adjacent mixed-version, and repeatable code-generation
  benchmark coverage.

### Changed

- Existing string resource keys, explicit hook generics, the `fluxfast/1`
  browser protocol, and JavaScript-only generation remain compatible while
  typed projects can make the FastAPI contract authoritative.
- Project generation now compiles and validates every schema-backed artifact
  before writing, and generated files include manifest provenance and
  fingerprint headers.

### Security

- Developer manifests are strictly validated before code generation, including
  manifest identity, fingerprints, resource and route metadata, mutation
  methods, and recursive JSON Schema structure.
- Generated identifiers, property names, route paths, query values, resource
  keys, and model names are escaped or normalized so untrusted manifest text
  remains inert data.
- Generated artifacts are confined to the configured FluxFast output directory
  and refuse path or symbolic-link traversal; prototype-sensitive schema keys
  are handled without object-prototype mutation.
- Offline schema export excludes loaders, dependencies, cache identifiers,
  scope identities, Redis metadata, and other runtime secrets, while production
  contract errors remain redacted.

## [0.5.0] - 2026-08-31

### Added

- Optional `RedisResourceCache` support for shared resource values across
  FastAPI processes and hosts, with native Redis TTLs and independently
  versioned cache entries.
- Atomic distributed resource deletion, tag indexing and invalidation, and
  bounded namespace-local clearing without `KEYS`, `FLUSHDB`, or `FLUSHALL`.
- Redis cache metrics, strict availability errors, corrupt-entry recovery,
  application lifecycle integration, and documented background publication
  through `LiveCoordinator`.
- Multi-worker, deferred, live, Redis restart, Redis 6–8 compatibility,
  production-browser, clean built-package, and mixed-version release coverage.

### Changed

- Positive-TTL Live Resources can now remain coherent across workers when
  `RedisResourceCache` is paired with `RedisLiveBroker`; application resource
  declarations and browser APIs remain unchanged.
- `FluxFast` now closes an owned closeable cache during application shutdown
  while preserving externally injected client ownership.

### Security

- Redis cache namespaces are explicit and validated; logical resource and tag
  identities are stored as opaque BLAKE2b digests, and cache payloads use
  bounded, schema-versioned JSON rather than executable serialization.
- Invalid or oversized stored payloads self-remove as cache misses, and Redis
  cache/live diagnostics omit credential-bearing URLs, resource identities,
  scopes, and cached values.

## [0.4.3] - 2026-08-31

### Fixed

- Missing-page redirects now preserve a real HTTP 404 without triggering
  React Server Components' negative `performance.measure()` timestamp error
  in local Next.js development.

## [0.4.2] - 2026-08-31

### Fixed

- Missing FastAPI routes now render Next.js not-found responses without
  triggering React's negative `performance.measure()` timestamp error during
  development-mode redirects.

## [0.4.1] - 2026-08-31

### Fixed

- Mutation redirects to missing FluxFast pages now fall back to document
  navigation so the Next.js not-found boundary can render, while non-404
  navigation failures remain visible to the caller.

## [0.4.0] - 2026-08-31

### Added

- Capability-negotiated Live Resources through `resource(..., live=True)`, with
  reusable-scope validation, authenticated fetch-based SSE subscriptions, and
  additive `fluxfast/1` page manifests.
- Framework-neutral live connection management with bounded reconnect backoff,
  offline recovery, canonical reconnect resynchronization, navigation cleanup,
  and the optional `useLiveStatus()` React hook.
- `MemoryLiveBroker` and optional `RedisLiveBroker` implementations supporting
  bounded subscriber queues, overflow resync, opaque scoped topics, and
  multi-worker publication.
- Scoped manual and mutation-driven invalidation broadcasts, origin-client
  suppression, immediate live patches, and canonical resource-only
  verification after live signals.
- Count-only live runtime diagnostics, the `X-FluxFast-Live-Resources` response
  header, and optional process-local connection, publication, resync, overflow,
  and error metrics.
- Browser, Redis restart, clean packed-consumer, published mixed-version, and
  controlled live benchmark coverage for the v0.4 release path.

### Changed

- Existing resource hooks now update automatically from live synchronization
  while preserving stale values during canonical revalidation; no separate
  live-resource state or hook is required.
- Page cache, history restoration, prefetch, deferred loading, and mutation
  races preserve the authoritative live manifest and reject obsolete work.

## [0.3.0] - 2026-08-30

### Added

- Capability-negotiated deferred resources for `fluxfast/1`, including
  `ResourceSpec(defer=True)`, cache-first pending metadata, automatic batched
  resource-only loading, and blocking fallback for older clients.
- `useDeferredResource` and `useResourceState` hooks with stable
  pending/loading/ready/error state, stale data, isolated per-resource errors,
  targeted retry, and convenience status booleans (`isLoading`, `isError`, `isReady`, `isPending`).
- Helpful development-only warnings when `useResource` is used on pending deferred resources.
- `X-FluxFast-Deferred-Pending` and `X-FluxFast-Deferred-Errors` diagnostic
  headers and client-side resource lifecycle events.
- Cancellation and per-key generation protection for deferred navigation,
  retry, refresh, and mutation races.
- Deferred browser coverage for SSR skeletons, cache restoration, isolated
  failure/retry, navigation cancellation, and mutation stale-while-revalidate,
  plus a controlled blocking-versus-deferred benchmark.

### Changed

- Page envelopes may include additive `resourceKeys`, `deferred`, and
  `resourceErrors` fields when the client advertises `deferred-resources`.
- PageCache tracks complete resource manifests and pending deferred keys so
  Back/Forward restoration remains coherent after settlement or eviction.
- Active mutation invalidations revalidate only subscribed resource keys while
  preserving stale data and leaving the current page and history untouched.

## [0.2.0] - 2026-08-29

### Added

- A safe, repeatable `fluxfast init` workflow that detects compatible Next.js
  App Router projects, creates the frontend scaffold, integrates `next.config`,
  migrates the standard starter page, and generates the component registry.
- Read-only `fluxfast init --dry-run`, `fluxfast init --check`, and
  `fluxfast doctor` diagnostics for previewing and validating frontend setup,
  plus an explicit `init --force` repair for invalid generated catch-all files.
- Packed clean-consumer build and live same-origin integration coverage for the
  initialized frontend.

## [0.1.0] - 2026-08-29

### Added

- FastAPI-owned pages, concurrent independently versioned resources, explicit
  cache scopes, mutations, invalidations, and redirects.
- A framework-neutral TypeScript runtime and a Next.js 16 App Router adapter.
- Single-command development with one public browser origin and a private,
  automatically selected FastAPI port.
- Package artifact smoke tests, trusted PyPI/npm publishing, compatibility
  matrices, browser tests, and dependency/security automation.

### Fixed

- Successful mutation responses omit unset optional wire fields instead of
  serializing them as incompatible `null` values.

[Unreleased]: https://github.com/El37628/FluxFast/compare/v0.8.0...HEAD
[0.1.0]: https://github.com/El37628/FluxFast/releases/tag/v0.1.0
[0.2.0]: https://github.com/El37628/FluxFast/releases/tag/v0.2.0
[0.3.0]: https://github.com/El37628/FluxFast/releases/tag/v0.3.0
[0.4.0]: https://github.com/El37628/FluxFast/releases/tag/v0.4.0
[0.4.1]: https://github.com/El37628/FluxFast/releases/tag/v0.4.1
[0.4.2]: https://github.com/El37628/FluxFast/releases/tag/v0.4.2
[0.4.3]: https://github.com/El37628/FluxFast/releases/tag/v0.4.3
[0.5.0]: https://github.com/El37628/FluxFast/releases/tag/v0.5.0
[0.6.0]: https://github.com/El37628/FluxFast/releases/tag/v0.6.0
[0.7.0]: https://github.com/El37628/FluxFast/releases/tag/v0.7.0
[0.8.0]: https://github.com/El37628/FluxFast/releases/tag/v0.8.0
