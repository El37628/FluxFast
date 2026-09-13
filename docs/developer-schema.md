# FluxFast developer schema

The developer manifest is an offline code-generation contract. It is separate
from the `fluxfast/1` browser protocol, package versions, runtime page data,
cache storage, and live-resource messages.

FluxFast 0.9 treats `fluxfast-schema/2` as the closed developer-manifest shape
expected through 1.0. Python produces schema/2; current JavaScript tooling reads
both schema/2 and the legacy `fluxfast-schema/1` format. Adding, removing, or
reinterpreting a manifest field requires a future `fluxfast-schema/3` and an
explicit migration path.

The shared fixtures are executable compatibility evidence:

- `tests/fixtures/schema/fluxfast-schema-v2.json` is produced by Python and
  consumed by every TypeScript compiler.
- `tests/fixtures/schema/fluxfast-schema-v1.json` is consumed by a complete
  generate, typecheck, and build test.
- `tests/fixtures/schema/developer-schema-v2-v0.9.0.json` pins the canonical
  v0.9.0 manifest digest, semantic fingerprint, supported readers, and v1.0.0
  producer-only transition.

The [v1.0 schema stability proof](releases/v1.0-schema-stability.md) records how
the candidate is compared with that baseline.

## Closed schema/2 shape

A schema/2 manifest has exactly these top-level fields, all required:

| Field | Contract |
| --- | --- |
| `schema` | Exact string `fluxfast-schema/2`. |
| `producer` | Producing Python package version in Semantic Versioning form. |
| `fingerprint` | Lowercase 64-character SHA-256 digest described below. |
| `types` | Object mapping explicit application contract names to type entries; present even when empty. |
| `resources` | Object mapping logical resource keys to resource entries; present even when empty. |
| `pages` | Array of page route entries; present even when empty. |
| `mutations` | Array of mutation route entries; present even when empty. |

Unknown fields are rejected at every structural level. JSON Schema objects may
contain standard schema keywords and extension metadata because their contents
describe application values rather than the manifest itself.

### Types and resources

Each `types` value has exactly:

```json
{
  "mode": "serialization",
  "schema": { "type": "object" }
}
```

`mode` is either `serialization` or `validation`, matching the mode registered
with `FluxFast.define_type()`. The producer calls Pydantic JSON Schema using
that mode and aliases enabled. This distinction is observable: serialization
aliases and validation aliases can differ.

Each `resources` value has exactly one `schema` field. Resource JSON Schema is
always produced in serialization mode with aliases enabled, matching the value
that a loader sends to the browser.

Contract names and resource keys are non-empty and at most 128 JavaScript
characters. Control characters are rejected; resource keys also cannot contain
commas.

### Pages and parameters

A page entry has exactly `name`, `path`, and `parameters`. A parameter has
exactly:

```json
{
  "name": "hotel_id",
  "location": "path",
  "required": true,
  "schema": { "type": "integer" }
}
```

`location` is `path` or `query`. Path parameters are always required. Page
parameter JSON Schema uses Pydantic serialization mode with aliases enabled,
because generated route builders serialize values into a URL. Dependencies are
walked without executing them; duplicate `(location, name)` entries are
collapsed. Parameters are emitted with path parameters first, then query
parameters, and sorted by name within each group.

### Mutations

A mutation entry has exactly `name`, `path`, `method`, `parameters`, and an
optional `body`. Supported methods are `DELETE`, `PATCH`, `POST`, and `PUT`.
A multi-method FastAPI mutation produces one entry per supported method.

Mutation parameter and JSON body schemas use Pydantic validation mode with
aliases enabled, matching accepted request input. `body` is emitted only for
JSON or `+json` request bodies; it is omitted for no body and for non-JSON media
types. Readers continue accepting either an omitted body or `null` as an
untyped mutation body. Mutation parameters follow the same representation and
ordering rules as page parameters.

Route names must be non-empty and at most 128 JavaScript characters. Route
paths start with `/`, contain no control characters, and are at most 2,048
JavaScript characters.

## Serialization and ordering

The producer never executes page functions, mutation functions, resource
loaders, or dependencies while exporting a manifest. It never includes runtime
values, cache scopes, user or tenant identities, credentials, machine paths, or
timestamps.

Output is deterministic under these rules:

- type and resource maps are ordered by key;
- pages are ordered by `(name, path)`;
- mutations are ordered by `(name, path, method)`;
- parameters are ordered by location group and name;
- JSON object keys are sorted recursively; and
- array order is retained where the underlying JSON Schema says order is
  meaningful.

Registration order therefore does not affect semantically unordered maps or
route collections. The producer version is visible metadata but does not
change the fingerprint.

## Fingerprint contract

The schema/2 fingerprint is SHA-256 over canonical UTF-8 JSON containing:

```text
schema
types
resources
pages
mutations
```

`producer` and `fingerprint` are excluded. Canonical JSON sorts every object
key, preserves array order, uses no insignificant whitespace, rejects non-finite
numbers, and emits Unicode directly. The result is encoded as a lowercase
hexadecimal digest.

Within schema/2, this canonicalization algorithm is stable. The fingerprint is
deterministic, independent of registration order where specified above,
machine paths, timestamps, and package patch versions. A change to any type,
resource, page, mutation, parameter, method, mode, or JSON body contract changes
the digest.

A future manifest version may intentionally use a different canonicalization
algorithm. Consumers must not assume equivalent schema/2 and schema/3 content
has the same digest.

## Schema/1 compatibility

`fluxfast-schema/1` has the same top-level shape except it has no `types` field.
It remains a readable legacy format through 1.0. Current JavaScript tooling
continues generating resource types, route builders, mutation helpers, and
supported validators from schema/1; removal is a future major-version decision.

Legacy JavaScript tooling is not required to understand schema/2. When it sees
schema/2, the Python CLI reports an actionable upgrade diagnostic rather than
silently generating incompatible output.

## Evolution policy

Compatible maintenance may correct security checks, diagnostics, or compiler
bugs without changing valid schema/2 meaning. The following changes are not
compatible within schema/2:

- adding a manifest, entry, or parameter field, even if described as optional;
- removing a field or changing requiredness;
- changing serialization or validation mode;
- adding or reinterpreting a mutation method or body rule;
- changing parameter representation; or
- changing fingerprint canonicalization.

Use `fluxfast-schema/3` for those changes and document how schema/2 consumers
must migrate or fail safely.
