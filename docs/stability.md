# Stability contract

FluxFast 0.9 is the compatibility freeze before 1.0. Before 0.9.0 is published,
a remaining public correction is acceptable only when preserving the old
behavior would make the 1.0 contract materially unsafe or incorrect. Once 0.9.0
is published, its public surface follows the compatible 0.9.x maintenance rules
below; only an extraordinary security issue with no compatible solution can
override them. Any such exception must include migration guidance.

This document defines the boundary. More detailed specifications remain
authoritative for their own domains and are linked below.

## Public and internal surfaces

A surface is public when applications can reasonably depend on it through an
official package path, documented command, generated artifact, or documented
runtime behavior. The v0.9 public surface includes:

- names exported by the top-level Python `fluxfast` package;
- names and paths exported by `@fluxfast/core` and `@fluxfast/next`;
- CLI commands, meaningful options, documented environment variables, major
  defaults, and success/failure semantics;
- generated filenames, exported names, and semantic TypeScript contracts;
- the `fluxfast/1` browser protocol, headers, capabilities, and patch behavior;
- the `fluxfast-schema/2` developer manifest and schema/1 reader compatibility;
- documented validation, mutation, resource, cache, scope, deferred, live,
  production, health, readiness, and runtime-support behavior.

The [Python](python-api.md), [`@fluxfast/core`](core-api.md), and
[`@fluxfast/next`](next-api.md) inventories classify exported names as stable
candidates, advanced stable candidates, or deprecated. Stable and advanced
stable candidates receive the same compatibility guarantee. "Advanced" means
that an API is primarily for adapter, transport, cache, live-resource, protocol,
or validation integrations; it does not mean experimental. Examples include
`LiveBroker`, `ResourceCacheBackend`, transport interfaces, validation-plan
APIs, and protocol types.

An implementation detail is internal only when it is not exposed through an
official package export and no public contract documents it. Undocumented deep
imports, underscore-prefixed Python implementation details, package `src` and
`dist` internals, generated private helpers, test controls, and repository
scripts are internal. Internal code may change without a compatibility promise,
provided the public behavior above is preserved.

## What is frozen in 0.9

The following are 1.0 candidates and must remain compatible throughout the 0.9
release line:

| Surface | Frozen contract |
| --- | --- |
| Python package | The documented `fluxfast.__all__` names, call shapes, and behavior. |
| Core package | The `@fluxfast/core` root path, its declarations, and framework-neutral runtime behavior. |
| Next package | The five documented `@fluxfast/next` export-map paths and their per-path declarations. |
| Browser protocol | `fluxfast/1`, its media type, headers, capabilities, envelopes, events, and patch semantics. |
| Developer schema | Closed `fluxfast-schema/2` shape and fingerprint rules, plus continued schema/1 reading. |
| Generated code | Stable filenames, public generated symbols, naming rules, and semantic TypeScript contracts. |
| CLI and configuration | Documented Python and JavaScript commands, meaningful flags, major defaults, exit semantics, and public environment variables. |
| Runtime behavior | Documented validation, resource, mutation, cache/scope, deferred, live, one-origin production, health, and lifecycle semantics. |
| Runtime support | Python 3.11–3.14, Node.js 22 and 24, Next.js `>=16.3.0 <17.0.0`, React 19+, and Redis 6.2–8.10 when Redis features are configured. |

The synchronized `fluxfast`, `@fluxfast/core`, and `@fluxfast/next` package
versions identify a matched release. Supported mixed-version behavior is
defined by the protocol, schema, generated-code, and adjacent-release consumer
gates; matching package versions remain the recommended production setup,
especially for supervisor-to-adapter production features.

Compatibility means that supported imports continue to resolve, documented
call shapes and commands retain their meaning, valid persisted or generated
inputs remain readable where promised, older and newer components fail safely
when a format is unsupported, and observable runtime semantics do not change in
a way that requires application rewrites. It does not mean that diagnostics,
source formatting, performance timings, or undocumented implementation choices
are byte-for-byte fixed.

## Package versioning

### The 0.9.x line

The 0.9 release line is reserved for:

- bug fixes;
- security fixes;
- performance fixes;
- compatibility fixes; and
- documentation corrections.

It does not introduce significant new public API, redesign existing APIs, or
remove compatibility-sensitive behavior. Small additive changes are considered
only when they are necessary to preserve security, correctness, or compatibility
and do not weaken the freeze.

### Version 1.0 and later

FluxFast 1.0 adopts the frozen candidates as the stable public contract. After
1.0, backwards-compatible additions may use a minor release and fixes may use a
patch release. Breaking public API changes require the next major package
version. The only exception is an extraordinary security issue for which no
compatible solution exists; the release must explain the impact and migration.

Package versions do not version the browser protocol or developer manifest. A
package major release does not by itself change either identifier, and a
breaking protocol or manifest change requires its own version bump.

## Deprecation policy

FluxFast avoids surprise removals. The normal process is:

```text
introduce a supported replacement
        -> mark the old API deprecated
        -> document migration
        -> retain it through compatible releases
        -> remove it only in a major release
```

Where practical, deprecation is visible in documentation and the type system or
runtime, but importing the package or starting an ordinary application must not
produce noisy warnings. The Python `ValidationError` and `PageNotFoundError`
compatibility exports are deprecated in v0.9 and remain importable through 1.0.
Immediate incompatible action is limited to extraordinary security or protocol
correctness cases where no compatible fix exists.

## Protocol evolution

`fluxfast/1` is expected to remain valid through FluxFast 1.0. A compatible v1
change may add ignorable optional metadata or capability-gated behavior only
when older clients remain correct and a safe no-capability fallback exists.
Capability names become public once shipped.

Removing or renaming a field, changing requiredness or existing meaning,
changing patch semantics, or requiring behavior an existing client cannot
safely ignore is incompatible and requires a new protocol identifier such as
`fluxfast/2`. The complete rules and cross-language fixtures are in the
[protocol specification](protocol.md).

## Developer schema evolution

Developer schema versions are independent from both package versions and the
browser protocol:

```text
fluxfast-schema/1  -> legacy readable format
fluxfast-schema/2  -> current closed format and 1.0 candidate
```

Current JavaScript tooling reads schema/1 and schema/2. Python emits schema/2.
Adding, removing, or reinterpreting manifest structure, changing producer mode,
or changing fingerprint canonicalization is incompatible within schema/2 and
requires a new identifier such as `fluxfast-schema/3`. See the [developer schema
specification](developer-schema.md).

## CLI compatibility

The stable Python command set is `fluxfast dev`, `build`, `start`, `doctor
--production`, `schema`, and `types`. The stable JavaScript command set is
`fluxfast init`, `generate`, and `doctor`. Their documented positional inputs,
meaningful flags, major defaults, read-only check modes, and success as exit
status `0` versus failure as nonzero are compatibility-sensitive. Exact human
diagnostic wording, log ordering, and undocumented exit-code distinctions are
not frozen.

The complete command and configuration inventories are in [production
deployment](production.md) and the [Next.js adapter guide](nextjs-adapter.md).

## Generated-code compatibility

Applications may depend on these generated filenames:

```text
schema.generated.json
types.generated.ts
validators.generated.ts
routes.generated.ts
mutations.generated.ts
pages.generated.ts
```

They may also depend on the documented public exported symbols, predictable
name derivation, accepted inputs, return types, and module relationships.
FluxFast does not guarantee whitespace, quote style, comment wording,
semantically irrelevant declaration ordering, or internal helper
implementation. Regenerate files during upgrades and review semantic changes.
For identical input and one FluxFast version, generation remains deterministic.
See the [generated artifact contract](generated-artifacts.md).

## Compatibility decisions

Every change to a public surface must identify its owning contract and prove
that supported consumers remain compatible. If compatibility cannot be
preserved, the change must be deferred to the appropriate major package,
protocol, or schema version unless the extraordinary security exception
applies. Security, tenant isolation, data integrity, protocol correctness, and
safe failure take precedence over cosmetic consistency.
