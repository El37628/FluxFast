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

## Preparing a release

Add user-facing entries beneath `Unreleased`, then run:

```bash
pnpm release:prepare 0.2.0
pnpm release:check v0.2.0
```

The preparation command synchronizes every package manifest, the Python runtime
version, `uv.lock`, and the dated changelog section. Review the resulting diff
before committing it. The release workflow refuses tags whose source versions
or changelog do not match.
