# Typed Contracts and Code Generation

FluxFast derives frontend types and native validators from explicit contracts
owned by the authoritative FastAPI application. Contracts describe the JSON values
crossing the wire or participating in frontend state; they do not inspect loaders,
execute application code, or make the frontend a second source of truth.

```text
Pydantic model on FastAPI
        ↓
ResourceContract or TypeContract
        ↓
server validation and serialization
        ↓
fluxfast-schema/2 developer manifest
        ↓
Unified Type Graph & Validator Compiler
        ↓
generated TypeScript contracts & native validators
```

This tooling does not change the `fluxfast/1` browser protocol and does not
serve a schema endpoint in production. For in-depth guides, see [General
Application Contracts](contracts.md) and [Native Client Validation](validation.md).

## Declare the server contract

Define each typed resource once on the `FluxFast` instance that owns the
application:

```python
from typing import Literal

from fastapi import Depends, FastAPI
from fluxfast import FluxFast, Page, resource, scope
from pydantic import BaseModel


class Room(BaseModel):
    id: int
    number: str
    status: Literal["available", "occupied"]


app = FastAPI()
flux = FluxFast(app)
ROOMS = flux.define_resource("rooms", list[Room])


@flux.page("/rooms", name="room_index")
async def room_index(hotel=Depends(current_hotel)) -> Page:
    return Page(
        component="rooms/index",
        resources=[
            resource(
                ROOMS,
                load_rooms,
                scope=scope.tenant(hotel.id),
                ttl=60,
            )
        ],
    )
```

`define_resource()` returns a `ResourceContract[T]`. Passing it to
`resource()` preserves the logical string key while associating the loader with
the declared type. The application rejects a second contract for the same key
instead of silently replacing the source of truth.

The existing string form remains supported:

```python
resource("legacy-summary", load_summary)
```

That resource is untyped and is omitted from generated resource contracts.
Typed and untyped declarations can coexist while an application migrates.

## Declare general application contracts

Applications also have models that are not tied to a specific resource loader—such
as form inputs, domain entities, mutation bodies, or state objects. Declare them
directly on `FluxFast` with `define_type()`:

```python
class CreateUserInput(BaseModel):
    name: str
    email: str

CREATE_USER_INPUT = flux.define_type(
    "CreateUserInput",
    CreateUserInput,
    mode="validation",
)
```

`define_type()` supports `mode="serialization"` (the default, representing server
output) and `mode="validation"` (representing server input). Unlike resource
contracts, general types do not define loaders or URL paths, but compile directly
into the frontend's generated type graph and native validators. See [General
Application Contracts](contracts.md) for details.

## Validation uses the serialized wire type

On a typed cache miss, FluxFast validates the loader result with Pydantic and
serializes it in JSON mode before versioning, caching, or returning it:

```text
loader result
    ↓
Pydantic validation
    ↓
serialization-mode JSON value
    ↓
resource version and cache
    ↓
browser envelope
```

The schema generator uses the same Pydantic serialization mode. Aliases,
enums, dates and datetimes, UUIDs, decimals, sets, nested and recursive models,
and custom serializers therefore describe their JSON representation rather
than their in-memory Python representation.

A contract mismatch raises `ResourceContractError`. With `FluxFast(app,
debug=True)`, diagnostics identify failing field paths without retaining the
rejected input. Production responses use the existing sanitized resource error
and do not expose values or validation details.

Memory and Redis caches store only the validated JSON-compatible value, never
Pydantic models or adapters. A valid cache hit reuses that canonical value and
does not rerun the loader or validation. When a deployment changes a cached
wire contract incompatibly, invalidate the affected keys or rotate the Redis
namespace as part of the deployment.

## Generate the frontend contracts

Run the full-stack helper from a Python environment that can import the FastAPI
application:

```bash
fluxfast types backend.main:app --frontend frontend
```

The command:

1. imports the application and exports its deterministic developer manifest;
2. selects npm, pnpm, Yarn, or Bun from the frontend project;
3. invokes the already-installed `@fluxfast/next` CLI without a package
   download fallback; and
4. lets the Next.js adapter detect a root or `src/` layout and generate every
   frontend artifact.

Schema export registers declarations but never executes page handlers,
resource loaders, FastAPI dependencies, authentication, or mutation handlers.
Generation validates the complete manifest and compiles every output before it
updates generated files.

For a `src/` project, output is written under `src/.fluxfast/`; a root-layout
project uses `.fluxfast/`:

| File | Contents |
| --- | --- |
| `schema.generated.json` | Deterministic `fluxfast-schema/2` developer manifest and fingerprint. |
| `types.generated.ts` | Models, general application contracts, reusable mutation bodies, `resourceKeys`, and `FluxResourceMap` augmentation. |
| `validators.generated.ts` | Native framework-neutral client validators for types, resources, and mutation bodies. |
| `routes.generated.ts` | Typed and safely encoded FastAPI page URL builders. |
| `mutations.generated.ts` | Typed JSON mutation helpers consuming reusable body contracts. |
| `pages.generated.ts` | Allowlisted lazy FluxFast page-component registry. |

Generated files are framework-owned. Do not edit them manually or run a
formatter over them. Regenerate after changing a resource contract, FluxFast
page or mutation signature, route name, or frontend page module.

The lower-level workflow remains available when a repository needs separate
backend and frontend jobs:

```bash
fluxfast schema backend.main:app \
  --output frontend/src/.fluxfast/schema.generated.json
cd frontend
npx fluxfast generate
```

Choose `.fluxfast/schema.generated.json` instead for a root-layout frontend.

## Consume generated resource types

The generated type file augments the framework-neutral `FluxResourceMap` in
`@fluxfast/core`. Known literal keys are inferred by `useResource`,
`useResourceState`, and `useDeferredResource`:

```tsx
"use client";

import { useResource } from "@fluxfast/next";
import { resourceKeys } from "@/.fluxfast/types.generated";

export default function RoomsPage() {
  const rooms = useResource(resourceKeys.rooms); // Room[]

  return rooms.map(room => (
    <p key={room.id}>
      {room.number}: {room.status}
    </p>
  ));
}
```

A known string literal such as `useResource("rooms")` receives the same
inference. A runtime-computed string remains `unknown`, because the compiler
cannot prove which contract it selects. Existing explicit generics such as
`useResource<Room[]>(dynamicKey)` remain supported for application-owned
dynamic logic.

For a deferred contract, use the lifecycle-aware hook without repeating its
type:

```tsx
const report = useDeferredResource(resourceKeys.report);

if (!report.data) return <ReportSkeleton />;
return <Report value={report.data} stale={report.stale} />;
```

## Use generated page routes

FluxFast derives path and query parameters only from explicitly registered
`@flux.page()` routes and their FastAPI validation metadata:

```python
@flux.page("/hotels/{hotel_id}/rooms", name="hotel_rooms")
async def hotel_rooms(hotel_id: int, status: str | None = None) -> Page:
    ...
```

The generated builder accepts the corresponding typed input and performs path
and query encoding:

```tsx
import { Link } from "@fluxfast/next";
import { routes } from "@/.fluxfast/routes.generated";

<Link href={routes.hotelRooms({
  hotel_id: 42,
  query: { status: "available" },
})}>
  Available rooms
</Link>
```

Give routes stable, unique names. FluxFast fails generation on normalized
TypeScript identifier collisions or inconsistent path placeholders rather than
overwriting a helper.

## Use generated JSON mutation helpers

Typed mutation helpers reuse the normal `FluxRouter.mutate()` path:

```python
class RoomInput(BaseModel):
    number: str


@flux.mutation("/hotels/{hotel_id}/rooms", name="add_room")
async def add_room(hotel_id: int, body: RoomInput):
    ...
```

```tsx
import { useRouter } from "@fluxfast/next";
import { mutations } from "@/.fluxfast/mutations.generated";

const router = useRouter();

await mutations.addRoom(router, {
  params: { hotel_id: 42 },
  body: { number: "301" },
});
```

The generated helper fixes the server-declared HTTP method, validates its
TypeScript input, safely encodes path and query values, and returns the existing
`MutationEnvelope`. Mutation bodies also export reusable named TypeScript interfaces
(e.g., `AddRoomBody` in `types.generated.ts`) and matching runtime validators
(e.g., `AddRoomBodyValidator` in `validators.generated.ts`). Generation covers JSON
bodies only; multipart, streaming, and arbitrary REST clients remain application
responsibilities.

## Native client validation

FluxFast generates native runtime validators for all registered type contracts,
resource models, and mutation bodies in `@/.fluxfast/validators.generated.ts`.
Validators are powered by `@fluxfast/core` without requiring Zod, Valibot, or any
external schema library.

```tsx
import type { AddRoomBody } from "@/.fluxfast/types.generated";
import { AddRoomBodyValidator } from "@/.fluxfast/validators.generated";
import { useForm } from "@fluxfast/next";

export function AddRoomForm() {
  const form = useForm<AddRoomBody>(
    { number: "" },
    { validator: AddRoomBodyValidator }
  );

  return (
    <form onSubmit={form.submit("/hotels/42/rooms")}>
      <input
        value={form.data.number}
        onChange={e => form.setData("number", e.target.value)}
      />
      {form.errors.number && <span>{form.errors.number}</span>}
      <button type="submit" disabled={form.processing}>Add Room</button>
    </form>
  );
}
```

Pre-submit validation prevents network submission if client constraints fail. See
[Native Client Validation](validation.md) for full details on validator APIs,
refinements, and error formatting.

## Detect schema drift in CI

The full-stack check recomputes the current backend manifest and frontend page
registry, compares every generated byte, and writes nothing:

```bash
fluxfast types backend.main:app --frontend frontend --check
```

A missing or stale manifest, type file, route helper, mutation helper, or page
registry returns a nonzero status with regeneration guidance. Run the normal
command locally, review the generated diff, and rerun the check.

Repositories with split jobs can use both lower-level checks:

```bash
fluxfast schema backend.main:app \
  --output frontend/src/.fluxfast/schema.generated.json \
  --check
cd frontend
npx fluxfast generate --check
```

`npx fluxfast doctor` also reports the manifest version and fingerprint,
contract, route, and mutation counts, unknown-producing schemas, identifier
collisions, and stale generated files. Doctor is diagnostic; the check command
is the deterministic CI gate.

## Deferred, live, and distributed resources

A `ResourceContract` composes with the existing resource options:

```python
ACTIVITY = flux.define_resource("activity", list[ActivityItem])

resource(
    ACTIVITY,
    load_activity,
    scope=scope.tenant(tenant.id),
    ttl=30,
    defer=True,
    live=True,
)
```

Typing does not change cache scope, deferred scheduling, live authorization,
invalidation, patch, or multi-worker behavior. It adds validation at the
server wire boundary and compile-time knowledge in the frontend. Keep using an
explicit reusable scope for cross-request caching and live resources, and use
`RedisResourceCache` plus `RedisLiveBroker` for shared positive-TTL live values
across workers.

For the complete runtime behavior, see [Deferred Resources](deferred-resources.md),
[Live Resources](live-resources.md), [Distributed Resource
Coherence](distributed-cache.md), [Mutations and Forms](mutations.md), [General
Application Contracts](contracts.md), [Native Client Validation](validation.md),
and the [Migration Guide](migration.md).
The architectural decisions and rejected alternatives are recorded in
[ADR-0006](decisions/0006-typed-resource-contracts.md) and
[ADR-0008](decisions/0008-general-contracts-and-native-validation.md).

## Compatibility and security boundaries

- String-key resources and explicit frontend generics remain supported.
- Python applications with typed contracts continue serving older JavaScript
  clients because no browser wire field changed.
- New JavaScript packages continue serving an older Python application and can
  generate the page registry without a schema manifest.
- `fluxfast-schema/2` is versioned independently from package versions and the
  `fluxfast/1` browser protocol. Tooling maintains backwards compatibility with
  `fluxfast-schema/1`.
- Manifests contain developer metadata, never loader values, scopes, user or
  tenant identities, cache keys, credentials, cookies, or authorization
  headers.
- Node validates manifest structure, bounded names, references, and output
  paths before generating code. Every output remains inside the detected
  `.fluxfast` directory.
- Client validation is an opt-in UX convenience; FastAPI and Pydantic remain the
  authoritative runtime validation boundary.

FluxFast intentionally does not infer contracts from loader annotations, parse
application ASTs, sample runtime responses, generate Python from TypeScript, or
transpile arbitrary Python validators into JavaScript.
