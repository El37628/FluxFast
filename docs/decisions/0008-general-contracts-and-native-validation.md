# ADR-0008: General application contracts and native client validation

Status: accepted.

## Context

FluxFast 0.6 introduced server-owned `ResourceContract[T]` declarations, the
`fluxfast-schema/1` developer manifest, and generated TypeScript types. That
model assumed that frontend types were inherently tied to FluxFast resources and
page loaders.

In practice, frontend applications require contracts well beyond resource
loaders:
1. Components, hooks, utilities, client-side stores, test fixtures, and custom
   fetch clients need authoritative TypeScript models that represent application
   entities rather than page resources.
2. Mutation request bodies were previously generated only as inline type
   literals within generated mutation helpers, making them difficult to reuse in
   form components or client-side validation logic.
3. Applications were forced to manually maintain parallel schema definitions
   using third-party libraries such as Zod, Valibot, or Yup to validate form
   inputs and client-side data, duplicating Pydantic schemas across languages and
   introducing drift.
4. Developers experienced friction when an entity model needed to be shared
   between different resources, mutations, and client-side states without having
   a dedicated resource endpoint.

Furthermore, client-side validation libraries introduce runtime weight, version
churn, and divergent validation semantics. Generating third-party schemas (such as
Zod schemas) would impose an external dependency on all consuming applications
and tie FluxFast's release cycle to third-party library internals.

## Decision

FluxFast 0.8 expands the contract architecture to support general application
types and provides a first-party, dependency-free client validation runtime
generated directly from authoritative Python/Pydantic schemas.

### 1. Explicit general application contracts

Applications declare authoritative models on their `FluxFast` instance
independently of resources using `flux.define_type()`:

```python
class User(BaseModel):
    id: int
    name: str
    email: str


USER = flux.define_type("User", User, mode="serialization")
CREATE_USER_INPUT = flux.define_type(
    "CreateUserInput",
    CreateUserInput,
    mode="validation",
)
```

Unlike a `ResourceContract`, a `TypeContract`:
- has no resource key;
- has no loader function;
- does not participate in caching, invalidation, or Live Resource topics; and
- does not alter browser protocol behavior.

Duplicate general type names on the same application are rejected immediately to
ensure that each named contract has a single authoritative declaration.

### 2. Input vs. output contract semantics

Data crossing the network has different constraints depending on direction:
- `mode="serialization"` (the default for `define_type` and all resources)
  describes JSON emitted by the server. It models the output of Pydantic
  serialization, reflecting Python date formatting, custom serializers, and
  alias configurations.
- `mode="validation"` describes JSON accepted by the server. It models Pydantic's
  input validation schema, enforcing input constraints, required fields, and
  acceptable coercion boundaries.

FluxFast deliberately avoids a magical `"both"` mode in v0.8. When distinct
representations are needed, developers name them explicitly (e.g., `UserInput` vs.
`User`), keeping generated contracts unambiguous and predictable.

### 3. fluxfast-schema/2 developer manifest

FluxFast 0.8 introduces the `fluxfast-schema/2` manifest specification. The
manifest format includes:
- an explicit `"schema": "fluxfast-schema/2"` version tag;
- a top-level `"types"` dictionary for explicitly defined application contracts;
- reusable mutation input schemas;
- resources, pages, and mutations; and
- a deterministic canonical SHA-256 fingerprint covering all contracts.

The browser wire protocol remains `fluxfast/1`. Developer manifest versioning is
independent of the browser transport protocol. The JavaScript tooling maintains
backward compatibility: `@fluxfast/next` 0.8 can consume both `fluxfast-schema/1`
and `fluxfast-schema/2` manifests.

### 4. Unified type graph compiler

The code generator refactors type generation into a unified schema graph
compiler. Explicit general types, resource schemas, mutation bodies, and
referenced schema `$defs` are compiled into a coherent TypeScript definition
graph:
- Identical schemas are deduplicated to single shared type declarations.
- Incompatible type definitions sharing a name produce generation errors rather
  than silent renaming or arbitrary merging.
- Explicit developer-assigned names (`flux.define_type("PublicUser", ...)`)
  always outrank inferred schema titles.
- Mutation request bodies are exported as reusable named interfaces (e.g.,
  `CreateRoomBody`).
- Existing imports from `@/.fluxfast/types.generated` remain fully backwards-compatible.

### 5. Native, dependency-free validation runtime

`@fluxfast/core` includes a lightweight, framework-neutral runtime validation
engine:
- Zero external runtime dependencies: no Zod, Valibot, Yup, Joi, or AJV is
  required.
- Tree-shakeable: Applications that do not import validators pay zero bundle
  overhead. Validator construction is pure (`/* @__PURE__ */ createValidator(...)`).
- Complete validation results: Exposes `FluxValidator<T>` with `validate()`,
  `is()`, and `assert()` methods returning structured `ValidationIssue` entries
  with structured paths and canonical error codes.
- Security-bounded evaluator: The runtime enforces execution limits (`maxDepth`,
  `maxOperations`, `maxIssues`, `maxProperties`), prevents prototype poisoning
  (`__proto__`, `constructor`), and detects cyclic/hostile objects safely.

### 6. Authoritative server boundary

Client-side validation is strictly for user experience (immediate feedback,
preventing pointless network requests for incomplete forms). FastAPI and Pydantic
remain the authoritative validation boundary for application correctness,
security, authorization, and business invariants. FluxFast does not double-validate
incoming server responses on the client.

### 7. No Python validator transpilation

FluxFast does not attempt to transpile arbitrary Python functions, regexes, or
Pydantic `@field_validator` methods into JavaScript. Validation plans are
derived purely from JSON Schema specifications emitted by Pydantic. Unsupported
schema keywords produce explicit compilation diagnostics and are never silently
ignored.

### 8. Synchronous validator refinements

To support simple client-side checks (such as confirming password matching),
`@fluxfast/core` provides `refineValidator()`:
- Refinements are strictly synchronous functions that run only after schema
  validation passes.
- Refinements cannot transform or mutate values; they return a `ValidationIssue` or
  `null`/`undefined`.
- FluxFast does not implement a full schema-builder DSL; applications requiring
  arbitrary multi-step schema compositions may continue using external validation
  libraries alongside FluxFast if desired.

### 9. useForm integration

`@fluxfast/next`'s `useForm` hook integrates seamlessly with native validators:
- Accepts an optional `validator` in options.
- Exposes synchronous `form.validate()`, `form.issues`, and a canonical
  `form.errorMap`.
- Automatically executes pre-submit validation during `form.submit()`, preventing
  the mutation request entirely if the data is invalid locally.
- Combines local client validation issues with authoritative FastAPI 422 server
  responses transparently.

## Consequences

- Applications have a single source of truth in Python for database models, API
  contracts, frontend TypeScript types, and client-side form validators.
- Developers no longer need to write or maintain duplicate TypeScript interfaces or
  third-party Zod/Valibot schemas.
- Bundle sizes remain minimal because no third-party validation library is
  bundled, and unused validators are tree-shaken.
- The `fluxfast/1` wire protocol remains unchanged; existing applications can adopt
  `define_type` and native validation incrementally.
