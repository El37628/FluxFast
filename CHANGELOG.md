# Changelog

Notable user-facing changes are recorded in this file. FluxFast follows
[Semantic Versioning](https://semver.org/).

## [Unreleased]

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

[Unreleased]: https://github.com/El37628/FluxFast/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/El37628/FluxFast/releases/tag/v0.1.0
