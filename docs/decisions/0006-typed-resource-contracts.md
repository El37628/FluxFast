# ADR-0006: Use explicit server-owned typed resource contracts

Status: accepted.

## Context

FluxFast resource declarations currently identify a resource by its logical
string key and loader. The FastAPI application often already has a Pydantic
model for that resource, but FluxFast has no authoritative association between
the key and the value's serialized shape. Frontend applications must therefore
duplicate Python models as TypeScript types, and a backend change can leave
those types stale without producing a compiler error.

FluxFast cannot safely infer a durable resource contract by executing loaders,
page handlers, dependencies, authentication, or mutations. Runtime response
sampling would be dependent on application state and user identity. Loader
return annotations are also not authoritative: they may be absent, unresolved,
decorated, conditional, or inaccurate.

The type contract must describe the JSON value that crosses the FluxFast wire,
not the Python object retained in memory. Types such as `datetime`, `UUID`,
`Decimal`, enums, sets, and custom Pydantic serializers make that distinction
observable.

## Decision

FluxFast 0.6 introduces an explicit, opt-in `ResourceContract[T]`. The
authoritative FastAPI application declares one through its `FluxFast` instance:

```python
ROOMS = flux.define_resource(
    "rooms",
    list[Room],
)
```

The returned contract retains the logical string key, the declared Python
annotation, and an internal Pydantic `TypeAdapter`. A page binds the contract to
a loader with the existing resource declaration:

```python
resource(
    ROOMS,
    load_rooms,
)
```

`resource("rooms", load_rooms)` remains supported as an untyped resource. A
typed resource carries its contract on `ResourceSpec`, while `ResourceSpec.key`
remains a string so caches, live topics, mutation invalidation, known-version
headers, and the `fluxfast/1` browser protocol keep their existing identities.

Each `FluxFast` instance owns a schema registry. Registries are never global,
because multiple applications may coexist in one Python process. Defining the
same logical key more than once on an application is rejected rather than
silently replacing the authoritative contract.

### Runtime boundary

On a cache miss, a typed resource follows this order:

```text
loader result
    ↓
Pydantic validation and serialization
    ↓
canonical JSON-compatible wire value
    ↓
resource version calculation
    ↓
MemoryResourceCache or RedisResourceCache
    ↓
fluxfast/1 envelope
```

Pydantic serialization mode is authoritative. The same serialization schema
used by developer tooling therefore describes the value validated and emitted
by the server. Caches contain only the canonical JSON-compatible value and its
existing metadata; they never contain Pydantic model instances, adapters, or
Python classes. Cache hits reuse that canonical value without re-running the
loader.

Contract violations raise a dedicated `ResourceContractError`. Development
diagnostics may identify failing fields, but production responses retain the
existing sanitized resource-resolution behavior and must not disclose values
or validation inputs.

Untyped resources retain the existing serialization path. Opting into one
typed resource does not force validation onto the rest of the application.
Deferred, live, patched, memory-cached, and Redis-cached resources keep their
current runtime semantics.

### Developer-tooling boundary

The server registry can be exported offline as a deterministic
`fluxfast-schema/1` manifest. This schema version is independent of both the
`fluxfast/1` browser protocol and the Redis cache schema. Export may import the
application so declarations register, but FluxFast does not execute loaders,
page handlers, dependencies, authentication, mutations, or database work.

The manifest contains developer metadata only:

- resource keys and Pydantic serialization JSON Schemas;
- explicitly registered FluxFast page route metadata;
- explicitly registered FluxFast mutation metadata;
- the producer version and a deterministic manifest fingerprint.

It never contains resource values, user or tenant identities, scope
fingerprints, cache or Redis keys, Redis URLs, credentials, cookies,
authorization headers, live topics, or loader results. FluxFast does not expose
an automatic production schema endpoint.

The Node generator validates the manifest before use and produces separate,
deterministic files for resource/model types, resource-key constants, page
route builders, and JSON mutation helpers. It continues to generate the
existing component registry independently. Generated artifacts contain no
machine-specific paths and require no formatter dependency.

Resource types augment a framework-neutral `FluxResourceMap` in
`@fluxfast/core`. Adapters use that registry to infer known resource keys while
preserving explicit generic calls and returning `unknown` for dynamic keys.
`@fluxfast/core` does not gain React or Next.js dependencies.

Page builders derive path and query types from authoritative FastAPI metadata
and safely encode all URL values. Mutation helpers cover JSON bodies and reuse
the existing `FluxRouter.mutate()` transport; they do not introduce another
HTTP client. Identifier normalization collisions fail with an actionable error
instead of overwriting generated members.

### Compatibility and versioning

Typed contracts and generated artifacts are additive. They do not add a
browser capability or change the `fluxfast/1` envelope, deferred manifests,
live signals, cache identities, or patch operations. Consequently:

- Python 0.6 with JavaScript 0.5 continues to run existing resources normally;
- Python 0.5 with JavaScript 0.6 continues to generate and use the existing
  component registry when no schema manifest exists;
- explicit calls such as `useResource<Room[]>("rooms")` remain valid;
- string-key Python resource declarations remain valid.

Schema and generated-file check modes compare deterministic bytes without
modifying files, making backend-to-frontend drift enforceable in CI.

## Consequences

- A resource's Python declaration becomes the single source of truth for both
  runtime validation and generated TypeScript.
- Pydantic-supported models, containers, unions, literals, enums, temporal
  types, UUIDs, decimals, dataclasses, generics, forward references, and custom
  serializers can be represented according to their JSON wire shape.
- Changing a typed backend contract changes the manifest fingerprint and can
  fail generation checks or frontend type checking until artifacts and usage
  are updated.
- Applications may migrate incrementally because typed and untyped resources
  can coexist.
- Runtime validation adds work on typed cache misses. Its cost and code
  generation performance must be benchmarked before release; cache-hit
  semantics remain unchanged.
- Schema export, manifest parsing, identifier generation, URL construction, and
  output paths become security boundaries and require adversarial tests.
- The Python registry must explicitly track FluxFast pages and mutations;
  generation cannot depend on fragile route-path heuristics.

## Scope exclusions

FluxFast 0.6 does not add runtime browser schema validation, a public schema
endpoint, frontend-to-Python generation, loader-annotation guessing, response
sampling, a generic REST client generator, multipart or streaming mutation
helpers, typed patch builders, Zod or Valibot output, another frontend adapter,
or a new browser transport. Those concerns are independent of declaring and
consuming typed FluxFast resources.

## Rejected alternatives

**Loader return annotations:** rejected because annotations are optional and
may not match the actual serialized contract. The explicit resource contract is
authoritative.

**AST parsing:** rejected because it cannot reliably reproduce imports,
Pydantic configuration, serializers, generics, or application registration.

**Executing loaders or sampling responses:** rejected because doing so is
stateful, can trigger application work, and may expose authentication-dependent
or tenant-dependent values.

**Frontend-owned models:** rejected because they preserve two independent
sources of truth and cannot validate the server's emitted wire value.

**OpenAPI as the resource contract:** rejected because FluxFast resources are
not a duplicate REST API. FastAPI/OpenAPI machinery may help describe
registered page and mutation parameters, but resource contracts remain
explicit FluxFast metadata.

**Runtime schema delivery and browser validation:** rejected because v0.6 needs
compile-time drift detection without increasing production protocol size or
validating every resource twice.

**A custom FluxFast schema language:** rejected because Pydantic already emits
serialization-mode JSON Schema. `fluxfast-schema/1` is a deterministic manifest
around those schemas, not a second model language.
