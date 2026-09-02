# Versioning and compatibility

FluxFast uses one synchronized [Semantic Version](https://semver.org/) for the
`fluxfast`, `@fluxfast/core`, and `@fluxfast/next` packages. The wire protocol is
versioned independently; package version `1.x` does not imply protocol version
1, and a breaking wire change requires the protocol process in
[`protocol.md`](protocol.md).

## Supported runtimes

| Runtime | Supported and tested |
| --- | --- |
| Python | 3.11, 3.12, 3.13, and 3.14 |
| Node.js | Active LTS lines 22 and 24 |
| Next.js | `>=16.3.0 <17.0.0` |
| React and React DOM | `>=19.0.0` |
| Redis Open Source server | 6.2 through 8.10 when Redis features are configured |

The CI matrices are the authoritative compatibility gate. Support for an
end-of-life runtime may be removed in a minor release before FluxFast 1.0 and
in a major release after 1.0.

## Package changes

- Patch releases contain backwards-compatible fixes and security updates.
- Minor releases add backwards-compatible features. Before 1.0, a minor
  release may also remove an API that was deprecated in an earlier minor.
- Major releases may make breaking public API changes.

Public APIs are deprecated in documentation and, where practical, with a
runtime or type-system warning for at least one minor release before removal.
Immediate removal remains possible for security vulnerabilities, behavior that
was never part of the documented public API, or changes required to preserve
protocol correctness.

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

## Developer schema and generated files

Typed resource tooling uses the independent `fluxfast-schema/1` developer
manifest. Its version is not the package version, the `fluxfast/1` browser
protocol, or the Redis cache schema. A breaking manifest-format change requires
a new schema identifier even when the package change is otherwise a normal
minor release.

Resource contracts, schema export, and generated TypeScript add no browser
capability or runtime envelope field. Compatibility therefore remains
directional and additive:

- a current typed Python server can serve an older JavaScript client through
  the unchanged browser protocol;
- current JavaScript packages can serve an older Python application and still
  generate the existing page registry when no manifest exists;
- string-key resources and explicit frontend hook generics remain supported;
  and
- generated files should be regenerated with the package versions under test
  rather than treated as a stable cross-version API by themselves.

Stable releases continue synchronizing all three package versions, and the
release gates test both adjacent mixed-package directions. See [typed resource
contracts and code generation](type-safety.md) for the build-time workflow and
[the release guide](releasing.md) for clean-consumer requirements.

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
pnpm release:prepare 0.7.0
pnpm release:check v0.7.0
```

The preparation command synchronizes every package manifest, the Python runtime
version, `uv.lock`, and the dated changelog section. Review the resulting diff
before committing it. The release workflow refuses tags whose source versions
or changelog do not match.
