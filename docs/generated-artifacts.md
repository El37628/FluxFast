# Generated Artifact Contract

FluxFast 0.9 treats the generated frontend API as a compatibility surface. The
Python application and Pydantic models remain authoritative; generated files
are the checked, local TypeScript representation consumed by application code.

## Stable filenames

The following names are stable throughout FluxFast 1.x:

```text
schema.generated.json
types.generated.ts
validators.generated.ts
routes.generated.ts
mutations.generated.ts
pages.generated.ts
```

They live together in the `.fluxfast` output directory selected by the
supported root or `src/` project layout. Changing between those layouts may
move the directory, but renaming one of these files would break generated
imports and is therefore a breaking change.

`fluxfast init` also writes `agent-knowledge.md` into that directory. It is a
generated AI-agent integration guide rather than a TypeScript or developer
schema API, so it is outside the semantic application-code contract below. The
initializer refreshes it independently and maintains bounded reference blocks
in the project-root `AGENTS.md` and `CLAUDE.md`; content outside those blocks is
user-owned and preserved.

## Stable generated API

In FluxFast 1.2, the framework-neutral compilers and safe
file-writing/checking infrastructure live in [`@fluxfast/codegen`](codegen-api.md).
Codegen scans and renders page registries through explicit runtime/export targets;
Next.js retains its public generator API and automatically supplies its default
target. This ownership change preserves all six Next artifact bytes;
it does not change the published v1.1 setup commands or manifest protocol.
The separate `fluxfast-codegen generate --adapter next` binary uses
the same artifact engine without replacing Next's existing `fluxfast generate`
binary. Its `--schema-file` and read-only `--check` modes preserve the same bytes.
The additive `--adapter react` target selects the shared React bindings without
a Next client directive. It uses `src/flux-pages` and `src/.fluxfast` when `src/`
exists, otherwise the project-root equivalents. For the same schema, the other
five generated files retain identical bytes. This target does not initialize or
start a Vite host; see the [Codegen CLI guide](codegen-api.md) for installation,
examples and the remaining integration boundaries.

The [`fluxfast-vite` CLI](vite-host.md) also uses the public Codegen
React target for `generate [--schema-file PATH] [--check]`, without evaluating
Vite configuration. Its `init` creates the registry and integration scaffold;
an existing or explicitly supplied backend schema adds the other five files.
It preserves SPA entries, custom scripts and user agent instructions, installing
no dependencies. Next's existing setup and generated artifact behavior remain
unchanged.

Application code may depend on these semantic exports:

| Artifact | Public generated concepts |
| --- | --- |
| `types.generated.ts` | Explicit application interfaces and aliases, Pydantic model names, `${PascalCaseResourceKey}Resource` resource aliases, mutation body types, `resourceKeys`, `GeneratedFluxResourceMap`, and the `FluxResourceMap` module augmentation. |
| `validators.generated.ts` | `${ContractName}Validator` constants, `validators`, and `validatorDiagnostics`. |
| `routes.generated.ts` | The `routes` object and its named page-route builders. |
| `mutations.generated.ts` | The `mutations` object and its named JSON mutation helpers. |
| `pages.generated.ts` | `fluxPages`, `FluxApplication`, and the default page registry export. |

`schema.generated.json` follows the separately versioned
[`fluxfast-schema/2` contract](developer-schema.md). It does not expose a
TypeScript module API.

The guarantee covers TypeScript meaning: names, accepted inputs, return types,
and module relationships. It does not freeze whitespace, comment wording,
quote style, semantically irrelevant declaration ordering, or private helper
implementations. A newer FluxFast release may reformat generated source, so
regenerate artifacts during upgrades. For one FluxFast version and identical
input, generation remains byte-for-byte deterministic and `--check` compares
those deterministic bytes without modifying files.

The [v1.0 generated-contract proof](releases/v1.0-generated-contract.md)
records the promotion comparison with a v0.9.0 semantic export and
normalized-source baseline for the same application contract.

## Name derivation

Common declarations retain predictable names:

- A resource key such as `hotel_rooms` produces `HotelRoomsResource` and
  `resourceKeys.hotelRooms`.
- A Pydantic model title such as `Room` remains the exported `Room` model.
- An explicit `define_type("RegistrationInput", ...)` contract produces
  `RegistrationInput`; its explicit contract name takes precedence over a
  different schema title.
- A JSON mutation named `create_room` produces `CreateRoomBody` and
  `mutations.createRoom`.
- When the same mutation name and path have multiple HTTP methods, the method
  is included, for example `SaveRoomPatchBody` and `mutations.saveRoomPatch`.
- A page route named `hotel_rooms` produces `routes.hotelRooms`.
- Each supported root contract named `RegistrationInput` produces
  `RegistrationInputValidator`; resource and mutation roots follow the same
  `${ContractName}Validator` rule.

ASCII word boundaries, underscores, hyphens, and existing camel-case
boundaries are normalized into PascalCase or camelCase as appropriate. A name
that normalizes to an existing generated symbol is rejected with a collision
diagnostic rather than silently renamed. Changing these derivation rules after
0.9 would be a breaking generated-API change.

## Generation and replacement safety

FluxFast compiles and validates the complete artifact set in memory before the
first write. A schema or compiler failure therefore leaves every existing file
untouched.

Each successful file replacement then uses this sequence:

```text
same-directory exclusive temporary file
→ write complete content
→ fsync the file
→ close the file
→ rename over the destination
→ best-effort temporary-file cleanup on failure
```

Keeping the temporary file beside its destination avoids a cross-filesystem
rename. Each destination is either its previous complete file or its new
complete file when replacement succeeds. This is deliberately a **per-file**
guarantee, not multi-file transactional atomicity: a filesystem failure during
a later replacement may leave earlier artifacts updated. Fix the filesystem
error and rerun generation to converge the deterministic set.

The generated-artifact contract tests exercise the replacement path on both
Linux and Windows. `fluxfast generate --check` and `fluxfast types --check`
remain read-only alternatives for CI drift detection.

## Upgrade guidance

Commit generated files only when that is the consuming project's policy. On an
upgrade, run generation once, review semantic changes separately from cosmetic
diffs, then run the read-only check:

```bash
fluxfast types backend.main:app --frontend frontend
fluxfast types backend.main:app --frontend frontend --check
```

See [typed contracts and code generation](type-safety.md), the [Next.js adapter
guide](nextjs-adapter.md), and [versioning](versioning.md) for the surrounding
schema, CLI, and package compatibility rules.
