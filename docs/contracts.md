# General Application Contracts

FluxFast allows developers to define server-owned contracts that are reusable
throughout the frontend application. Generated TypeScript types are not
conceptually tied to page loaders or resource fetches; they represent
authoritative application models that can be consumed by components, hooks,
libraries, forms, stores, test suites, and custom utilities.

Python and Pydantic remain the single source of truth. Developers define
contracts once on the backend, export them into a deterministic
`fluxfast-schema/2` manifest, and compile them into a unified TypeScript type
graph.

```text
Python / Pydantic Model
          ↓
FluxFast define_type / define_resource
          ↓
fluxfast-schema/2 developer manifest
          ↓
Unified Type Graph Compiler
          ↓
@/.fluxfast/types.generated.ts
```

---

## Declaring general contracts

Define application types on your `FluxFast` instance with `flux.define_type()`:

```python
from pydantic import BaseModel, EmailStr
from fluxfast import FluxFast


class User(BaseModel):
    id: int
    name: str
    email: EmailStr


class CreateUserInput(BaseModel):
    name: str
    email: EmailStr


app = FastAPI()
flux = FluxFast(app)

# Serialized/output contract (default)
USER = flux.define_type("User", User)

# Validation/input contract
CREATE_USER_INPUT = flux.define_type(
    "CreateUserInput",
    CreateUserInput,
    mode="validation",
)
```

`flux.define_type()` registers a `TypeContract[T]`. Unlike a `ResourceContract`, a
`TypeContract`:
- does not have a resource key or URL path;
- does not define a data loader;
- does not participate in server caching, live updates, or invalidation; and
- does not affect the `fluxfast/1` browser wire protocol.

Each `FluxFast` application instance owns its own contract registry. Registering
the same type name more than once raises an immediate error, ensuring exactly one
authoritative declaration per named contract.

---

## Serialization vs. validation semantics

Data crossing the wire often has different representations depending on direction:

| Mode | Purpose | Pydantic Schema | Common Use Cases |
| --- | --- | --- | --- |
| `mode="serialization"` (default) | Output: server → client | Serialization mode schema | Application entities, query results, custom fetch responses |
| `mode="validation"` | Input: client → server | Validation mode schema | Form inputs, mutation request bodies, action payloads |

### Why mode matters

Pydantic schemas can diverge significantly between input and output modes:
- **Computed fields and serializers:** Properties decorated with `@computed_field`
  or `@field_serializer` appear in serialization mode but are rejected in validation mode.
- **Aliases:** Fields using `validation_alias` vs. `serialization_alias` have
  different keys in input versus output payloads.
- **Coercion:** Types such as `datetime`, `Decimal`, or `UUID` may accept string
  inputs during validation, but serialize into specific string formats.

FluxFast intentionally does not offer a combined `"both"` mode in v0.8. If an entity
has different input and output shapes, declare them explicitly:

```python
flux.define_type("User", User, mode="serialization")
flux.define_type("UserInput", UserInput, mode="validation")
```

This prevents ambiguous generated interfaces and ensures the generated TypeScript
matches the exact network payload.

---

## Automatic contract discovery

FluxFast generates a single coherent type graph combining three sources:

### 1. Resource contracts

Existing resource declarations continue to export their models automatically:

```python
ROOMS = flux.define_resource("rooms", list[Room])
```

This generates `export interface Room { ... }` and `export type RoomsResource = Room[];`.
You do not need to call `define_type("Room", Room)` if `Room` is already part of a
resource contract.

### 2. Reusable mutation bodies

FastAPI mutation request bodies are compiled into reusable named interfaces rather
than inline type literals:

```python
class CreateRoomInput(BaseModel):
    number: str
    floor: int


@flux.mutation("/hotels/{hotel_id}/rooms", name="create_room")
async def create_room(hotel_id: int, body: CreateRoomInput):
    ...
```

The compiler generates a reusable interface in `types.generated.ts`:

```ts
export interface CreateRoomBody {
  number: string;
  floor: number;
}
```

The generated mutation helper in `mutations.generated.ts` references this named
interface:

```ts
mutations.createRoom(router, {
  params: { hotel_id: 42 },
  body: { number: "101", floor: 1 },
});
```

Application code can import and reuse `CreateRoomBody` directly in form components,
hooks, and client-side utilities.

### 3. Explicit general types

Any model registered with `flux.define_type()` is emitted as a top-level exported
interface or type alias in `types.generated.ts`.

---

## Unified Type Graph Compiler

All contracts participate in a global type graph compiler:

1. **Global deduplication:** When multiple resources, mutations, or general types
   reference the same model or definition, the compiler emits a single shared
   interface.
2. **Deterministic naming:** Explicit names provided via `define_type()` or
   `define_resource()` always take precedence over inferred Pydantic model titles.
3. **Collision safety:** If two incompatible schemas share the same type name,
   code generation halts with a clear error diagnostic. The compiler never silently
   renames or merges conflicting schemas.
4. **Referenced definitions (`$defs`):** Nested and recursive models referenced
   across schemas are resolved into cleanly scoped, named TypeScript declarations.

---

## Using contracts in frontend code

Generated types can be imported anywhere in your frontend project:

```tsx
import type { User, CreateRoomBody } from "@/.fluxfast/types.generated";

// In a presentation component:
export function UserProfile({ user }: { user: User }) {
  return <div>{user.name} ({user.email})</div>;
}

// In a custom state store:
export interface AppState {
  currentUser: User | null;
  pendingRoom: CreateRoomBody | null;
}

// In a client-side utility:
export function formatUserLabel(user: User): string {
  return `${user.name} <${user.email}>`;
}
```

Existing imports from `@/.fluxfast/types.generated` (such as `resourceKeys` and
`FluxResourceMap`) remain fully supported.

---

## The `fluxfast-schema/2` manifest

FluxFast 0.8 uses the `fluxfast-schema/2` specification for offline developer
manifests.

### Manifest structure

```json
{
  "schema": "fluxfast-schema/2",
  "producer": "0.8.0",
  "fingerprint": "a3f5c...",
  "types": {
    "User": {
      "mode": "serialization",
      "schema": { "type": "object", "properties": { ... } }
    },
    "CreateUserInput": {
      "mode": "validation",
      "schema": { "type": "object", "properties": { ... } }
    }
  },
  "resources": { ... },
  "pages": [ ... ],
  "mutations": [ ... ]
}
```

### Fingerprinting and drift detection

The manifest includes a canonical SHA-256 fingerprint calculated over a sorted,
deterministic representation of all types, resources, pages, and mutations. Any
change to a contract alters the fingerprint.

In CI or pre-commit checks, verify that generated files are up to date:

```bash
fluxfast types backend.main:app --frontend frontend --check
```

If contracts have drifted, the command exits with a non-zero code and describes
the stale artifacts without modifying files.

### Backward compatibility

The `@fluxfast/next` 0.8 CLI seamlessly reads both `fluxfast-schema/1` and
`fluxfast-schema/2` manifests. When reading a schema/1 manifest, general application
types are omitted, and existing resource models and page routes continue to compile
without issue. See the [Migration Guide](migration.md) for upgrading from 0.7.

---

## Related documentation

- [Native Client Validation](validation.md)
- [Typed Contracts and Code Generation](type-safety.md)
- [Migration Guide](migration.md)
- [ADR-0008: General application contracts and native client validation](decisions/0008-general-contracts-and-native-validation.md)
