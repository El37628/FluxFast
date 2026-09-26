# Stability contract

FluxFast 1.x follows semantic versioning. FluxFast 1.0 adopts the public
contract frozen and proven against v0.9.0 as its stable contract. Compatible
1.x releases preserve that contract; breaking package API changes require
2.0.0. Only an extraordinary security issue with no compatible solution can
override that rule, and any such exception must include migration guidance.

This document defines the boundary. More detailed specifications remain
authoritative for their own domains and are linked below.

## Public and internal surfaces

A surface is public when applications can reasonably depend on it through an
official package path, documented command, generated artifact, or documented
runtime behavior. The FluxFast 1.x public surface includes:

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
[`@fluxfast/next`](next-api.md) inventories classify exported names as stable,
advanced stable, or deprecated. Stable and advanced stable APIs receive the
same compatibility guarantee. "Advanced" means that an API is primarily for
adapter, transport, cache, live-resource, protocol, or validation integrations;
it does not mean experimental. Examples include
`LiveBroker`, `ResourceCacheBackend`, transport interfaces, validation-plan
APIs, and protocol types.

For practical selection guidance and working examples, see
[Stable APIs for application developers](stable-apis.md) and
[Advanced Stable APIs for integration authors](advanced-stable-apis.md).

An implementation detail is internal only when it is not exposed through an
official package export and no public contract documents it. Undocumented deep
imports, underscore-prefixed Python implementation details, package `src` and
`dist` internals, generated private helpers, test controls, and repository
scripts are internal. Internal code may change without a compatibility promise,
provided the public behavior above is preserved.

## What is stable in 1.x

The following contracts are stable throughout the 1.x release line:

| Surface | Stable contract |
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

### Machine-checkable reference

The exact adjacent promotion snapshot is
[`tests/fixtures/public-api-v0.9.0.json`](../tests/fixtures/public-api-v0.9.0.json).
It records the Python and npm export surfaces together with the CLI,
environment-variable, protocol, schema, capability, and generated-filename
contracts adopted from v0.9.0. The historical
[`public-api-v0.8.1.json`](../tests/fixtures/public-api-v0.8.1.json) snapshot is
retained so compatibility history is not rewritten when the promotion baseline
advances.

The browser protocol has a separate semantic snapshot at
[`tests/fixtures/protocol-v1-v0.9.0.json`](../tests/fixtures/protocol-v1-v0.9.0.json).
It freezes canonical hashes for every shared `fluxfast/1` envelope fixture plus
the request headers, safety limits, capabilities, patch operations, and live
event facts that must remain independent from Python and npm package versions.

The npm portion also fingerprints the complete declaration dependency graph of
every public Core and Next entry point. The fingerprint ignores comments and
whitespace but changes when declaration tokens, referenced public types, or
entry-point dependencies change. This makes signature drift fail the same gate
as an added or removed export.

The focused documentation-consistency gate compares this small fact set with
package metadata, CI matrices, Python and TypeScript constants, generator
source, and the detailed specifications. It is intentionally not a general
Markdown compiler.

<!-- stability-facts:start -->
```json
{
  "runtime": {
    "python": ["3.11", "3.12", "3.13", "3.14"],
    "node": ["22", "24"],
    "nextPeer": ">=16.3.0 <17.0.0",
    "reactPeer": ">=19.0.0"
  },
  "protocolVersion": "fluxfast/1",
  "schema": {
    "readable": ["fluxfast-schema/1", "fluxfast-schema/2"],
    "produced": "fluxfast-schema/2"
  },
  "capabilities": ["deferred-resources", "live-resources"],
  "validationFormats": [
    "date",
    "date-time",
    "email",
    "ipv4",
    "ipv6",
    "time",
    "uri",
    "uuid"
  ],
  "generatedFiles": [
    "mutations.generated.ts",
    "pages.generated.ts",
    "routes.generated.ts",
    "schema.generated.json",
    "types.generated.ts",
    "validators.generated.ts"
  ],
  "packageEntryPoints": {
    "fluxfast": ["fluxfast"],
    "@fluxfast/core": ["."],
    "@fluxfast/next": [
      ".",
      "./client",
      "./generate",
      "./next-config",
      "./server"
    ]
  }
}
```
<!-- stability-facts:end -->

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

### Patch releases: 1.0.x

Patch releases are for bug fixes, security fixes, compatible performance fixes,
and documentation corrections. They may also repair compatibility without
changing the documented public contract.

### Minor releases: 1.x.0

Minor releases may add backwards-compatible features. Existing supported
applications must continue to build and run without source rewrites.

### Major releases: 2.0.0

A breaking public package API change requires a major release. The normal
deprecation process applies before removal whenever practical.

Package versions do not version the browser protocol or developer manifest.
Package v2 does not automatically imply `fluxfast/2`, and `fluxfast/2` does
not automatically imply package v2. The protocol identifier changes only when
the wire contract requires it. Likewise, FluxFast 1.x may continue using
`fluxfast-schema/2` for the entire major line; a manifest version changes only
when that offline schema contract requires it.

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
compatibility exports are deprecated and remain importable throughout 1.x.
Immediate incompatible action is limited to extraordinary security or protocol
correctness cases where no compatible fix exists.

## Protocol evolution

`fluxfast/1` remains valid throughout FluxFast 1.x. A compatible protocol-v1
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
fluxfast-schema/2  -> current closed format, stable for FluxFast 1.x
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
