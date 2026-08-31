# Changelog

Notable user-facing changes are recorded in this file. FluxFast follows
[Semantic Versioning](https://semver.org/).

## [Unreleased]

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

[Unreleased]: https://github.com/El37628/FluxFast/compare/v0.4.0...HEAD
[0.1.0]: https://github.com/El37628/FluxFast/releases/tag/v0.1.0
[0.2.0]: https://github.com/El37628/FluxFast/releases/tag/v0.2.0
[0.3.0]: https://github.com/El37628/FluxFast/releases/tag/v0.3.0
[0.4.0]: https://github.com/El37628/FluxFast/releases/tag/v0.4.0
