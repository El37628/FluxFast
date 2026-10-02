# Versioning and compatibility

FluxFast uses one synchronized [Semantic Version](https://semver.org/) for the
`fluxfast` Python distribution and all six npm packages: `@fluxfast/core`,
`@fluxfast/next`, `@fluxfast/devtools`, `@fluxfast/codegen`, `@fluxfast/react`,
and `@fluxfast/vite`. DevTools joins this synchronized set in v1.1; Codegen,
React and Vite join in v1.2. The wire protocol is
versioned independently; package version `1.x` does not imply protocol version
1, and a breaking wire change requires the protocol process in
[`protocol.md`](protocol.md). The central [stability contract](stability.md)
defines what FluxFast 1.x treats as public, stable, deprecated, and internal.

Package and protocol major versions are independent. Package v2 does not
automatically imply `fluxfast/2`, and `fluxfast/2` does not automatically
imply package v2. The protocol identifier changes only when the wire contract
requires it.

## Supported runtimes

| Runtime | Supported and tested |
| --- | --- |
| Python | 3.11, 3.12, 3.13, and 3.14 |
| Node.js | 22 and 24 |
| Next.js | `>=16.3.0 <17.0.0` |
| React and React DOM | `>=19.0.0` |
| Vite (React host only) | `>=7.3.6 <8.0.0`, with Node 22.12+ or 24 |
| Redis Open Source server | 6.2 through 8.10 when Redis features are configured |

The CI matrices are the authoritative compatibility gate. Python tests run on
every minor from 3.11 through 3.14, and JavaScript tests run on Node 22 and 24.
Packed release consumers test the minimum Next.js 16.3.0 with React 19.0.0 on
Node 22 and resolve the latest compatible Next.js 16 and React 19 releases on
Node 24. This prevents the monorepo's installed dependency versions from being
the only compatibility evidence. React/Vite consumers separately test both
Node lines and React 19.0.0 at the peer floor, with real development and
production SSR/hydration. The Vite host's Node 22.12 minimum does not raise the
existing Next adapter's Node 22 contract.

FluxFast 1.x supports this matrix. A line may be removed in a compatible release
only when an upstream dependency makes continued support impractical; such an
exception requires an explicit compatibility decision and migration note.
Dependabot security and required compatibility updates may advance versions
inside these ranges, but dependency updates must not silently widen the public
runtime or peer-dependency contract. Major dependency churn requires an
explicit compatibility review and concrete user benefit.

## Package changes

- Patch releases such as `1.0.x` contain bug fixes, security fixes, compatible
  performance fixes, and documentation corrections.
- Minor releases such as `1.x.0` may add backwards-compatible features.
- Breaking public package API changes require a major release such as `2.0.0`.
  An extraordinary security fix may be incompatible only when no compatible
  solution exists; its impact and migration must be documented.

The normal deprecation path introduces a supported replacement, marks the old
API deprecated, documents migration, retains it through compatible releases,
and removes it only in a major release. Where practical, documentation is
reinforced with a runtime or type-system warning without producing noise on an
ordinary import or application startup. The only immediate incompatible action
is the extraordinary security or protocol-correctness case where no compatible
fix exists.

FluxFast 1.x exported APIs are classified as stable, advanced stable,
deprecated, or internal. Stable and advanced stable APIs receive the same
compatibility treatment; the distinction describes the expected audience, not
a weaker guarantee. The complete
top-level Python inventory and the two compatibility-only deprecated exports
are recorded in the [Python public API contract](python-api.md). The complete
framework-neutral JavaScript inventory is recorded in the
[`@fluxfast/core` API contract](core-api.md). The Next.js adapter's supported
symbols and five public package paths are recorded in the
[`@fluxfast/next` API contract](next-api.md). The optional DevTools package has
one public root entry exposing `FluxDevtools` and `FluxDevtoolsProps`; its
internal store and projections are not public API.

From 1.2, the [React API](react-api.md), [SSR/hydration boundary](react-ssr.md),
[Vite host](vite-host.md), [Codegen API](codegen-api.md), and
[Core server entry](core-api.md#server-adapter-primitives-fluxfast-12) document
the additional public surfaces. Follow the [1.2 release notes](releases/v1.2.0.md)
to distinguish versioned capabilities from actual registry publication.

## Capability negotiation

Capabilities negotiate optional additive behavior independently from package
and wire-protocol versions. A client lists supported tokens in
`X-FluxFast-Capabilities`; the server uses only recognized, shipped tokens and
ignores malformed or unknown input within bounded parsing limits.

FluxFast 0.3 introduced `deferred-resources`; FluxFast 0.4 introduced
`live-resources`. A capable server may add the corresponding optional
`resourceKeys`, `deferred`, `resourceErrors`, and `live` fields to a
`fluxfast/1` page envelope. Compatibility works in both directions:

- a new client can consume an old server's ordinary v1 envelope;
- a new server keeps `defer=True` resources blocking for a client that does not
  advertise the capability; and
- an old server ignores the new client's unknown request header.

This permits progressive optional behavior without incrementing the protocol
identifier merely because packages gained a feature. It does not permit
changing required v1 fields or their existing semantics. A change that cannot
provide a safe no-capability fallback, requires clients to understand new
behavior, or reinterprets an existing field still requires a new wire protocol.

Capability names are public compatibility surface once shipped. Do not publish
or depend on names for planned features until their request, response, fallback,
and security behavior are implemented and documented. See
[`protocol.md`](protocol.md) for the current token and field contract.
The protocol specification also defines the frozen `fluxfast/1` headers,
evolution rules, and shared cross-language compatibility fixtures.

## Developer schema and generated files

Contract generation uses the independent developer manifest specification.
FluxFast 0.6 introduced `fluxfast-schema/1` for typed resources; FluxFast 0.8
introduces `fluxfast-schema/2` to support explicitly registered general
application contracts (`types`) and reusable mutation request bodies.

The manifest version is not the package version, the `fluxfast/1` browser
protocol, or the Redis cache schema. A breaking manifest-format change requires
a new schema identifier even when the package change is otherwise a normal
minor release. FluxFast 1.x may continue using `fluxfast-schema/2` for the
entire major line.

FluxFast 1.x treats schema/2 as a closed, stable manifest shape.
Its fields, producer modes, ordering rules, and fingerprint algorithm are
defined by the [developer schema specification](developer-schema.md). New
manifest structure requires `fluxfast-schema/3`; schema/1 remains readable by
current JavaScript tooling throughout 1.x.

Compatibility remains directional and additive:

- `@fluxfast/next` 0.8 understands both `fluxfast-schema/2` and legacy
  `fluxfast-schema/1` manifests, preserving compatibility for existing projects;
- if legacy JavaScript tooling encounters a `fluxfast-schema/2` manifest, it
  fails with an actionable diagnostic advising a package upgrade rather than
  emitting corrupted files;
- a current typed Python server can serve an older JavaScript client through
  the unchanged `fluxfast/1` browser protocol;
- current JavaScript packages can serve an older Python application and still
  generate the existing page registry when no manifest exists;
- string-key resources and explicit frontend hook generics remain supported;
  and
- generated files should be regenerated with the package versions under test.
  From 0.9, their filenames, public exported symbols, and semantic TypeScript
  contracts are stable throughout 1.x; cosmetic source formatting is
  not. The complete boundary is defined by the [generated artifact
  contract](generated-artifacts.md).

Stable releases synchronize the complete package set available in their minor
line: four package versions in v1.1 and seven in v1.2.
The 0.9
release gates start a real consumer with Python and JavaScript packages at
0.8.1, upgrade Python first and JavaScript first in separate runs, and verify
each mixed state before reaching the matched 0.9 candidate. Each run regenerates
typed files, typechecks, production-builds, and exercises navigation, deferred
and live resources, mutations, and the distributed Redis path. It then
reinstalls 0.8.1, regenerates, rebuilds, and confirms that repeated `fluxfast
init` calls did not rewrite the existing application scaffold. See [typed
contracts and code generation](type-safety.md), [General Application
Contracts](contracts.md), the [Migration Guide](migration.md), and [the release
guide](releasing.md) for clean-consumer requirements.

The 1.0 promotion gate advances the adjacent baseline to v0.9.0. It exercises
current-source Python with published v0.9 JavaScript, current-source JavaScript
with published v0.9 Python, the matched current-source candidate, and a complete
rollback to published v0.9.0. Every state regenerates and typechecks contracts,
builds and runs the Next.js production server, and verifies SSR, navigation,
resource-delta reuse, server validation, mutations, deferred/live resources,
and Redis behavior across independent workers. A single-direction v0.8.1 smoke
remains as inexpensive historical evidence; it is no longer the adjacent gate.

The 1.1 release advances the adjacent baseline to v1.0.1 in both upgrade
orders, while retaining a one-direction v0.9.0 historical smoke. DevTools is an
optional new v1.1 artifact and has no v1.0 counterpart; mixed application
compatibility continues to exercise the Python, Core, and Next packages. The
independent `fluxfast-devtools/1` diagnostic channel adds no fields to
`fluxfast/1`, and a production consumer does not require the DevTools package.

The 1.2 gates retain both published 1.0.1 and 1.1.0 Next application baselines,
exercise both upgrade/rollback orders, and check matched React/Vite packages in
clean candidate-archive and registry-only consumers. The new React host requires
matching 1.2 Python and JavaScript packages; older Python supervision cannot
select it. See the [release guide](releasing.md).

## Production runtime compatibility

FluxFast 0.7 adds production orchestration without changing the `fluxfast/1`
browser protocol or `fluxfast-schema/1` developer manifest. Existing
applications may continue managing Uvicorn and Next.js separately, although
the supported one-service deployment uses `fluxfast build` and `fluxfast
start`.

Protocol-level resource, deferred, live, mutation, cache, and generated-type
behavior remains compatible between 0.7 and 0.6 packages in both mixed-package
directions. Production features that cross the Python supervisor and Next.js
adapter boundary—especially the public health routes and private runtime
transport—require matching 0.7 Python and JavaScript packages. Run `fluxfast
doctor --production --strict` before deployment; synchronized stable package
versions are the recommended production configuration.

The adjacent-version release gates distinguish these concerns: mixed 0.7/0.6
consumers prove unchanged application behavior, while the clean matched 0.7
consumer proves the new build, start, health, shutdown, and one-origin
production path. See [production deployment](production.md) and
[ADR-0007](decisions/0007-production-runtime.md).

## Preparing a release

Add user-facing entries beneath `Unreleased`, then run:

```bash
pnpm release:prepare 1.1.0
pnpm release:check v1.1.0
```

The preparation command synchronizes every package manifest, the Python runtime
version, `uv.lock`, and the dated changelog section. Review the resulting diff
before committing it. The release workflow refuses tags whose source versions
or changelog do not match.
