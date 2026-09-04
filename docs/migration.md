# Migrating to FluxFast 0.8

FluxFast 0.8 expands server-owned contracts into general application models
and introduces native, dependency-free client validation.

This guide helps existing FluxFast 0.7 applications upgrade to 0.8.0. The release
maintains backward compatibility for the `fluxfast/1` browser wire protocol,
existing resource models, page URL routes, and generated type imports.

---

## What's new in v0.8.0

1. **General Application Contracts (`flux.define_type`):** Define authoritative
   contracts with Pydantic that are not tied to page loaders or resource keys.
2. **`fluxfast-schema/2` Developer Manifest:** An expanded developer schema
   manifest format with deterministic fingerprinting covering general types and
   reusable mutation bodies.
3. **Unified Type Graph Compiler:** Shared definitions (`$defs`), deduplication,
   and collision detection across resources, mutations, and general types.
4. **Reusable Mutation Body Contracts:** Mutation request bodies generate
   exported interfaces (`${PascalCase}Body`) in `types.generated.ts`.
5. **Native Runtime Validation (`validators.generated.ts`):** Framework-neutral,
   zero-dependency validators powered by `@fluxfast/core`, replacing external
   libraries like Zod or Valibot for generated contracts.
6. **Form Validation with `useForm`:** Pre-submit client validation prevents
   invalid network requests and surfaces structured `issues` and dot-path
   `errorMap` mappings alongside server validation errors.
7. **Tree-shakeable Bundles:** Applications that do not import validators pay
   zero runtime bundle overhead.

---

## Upgrade Steps

### 1. Update package dependencies

Update your Python and JavaScript dependencies to 0.8.0.

In `pyproject.toml` (or `requirements.txt`):

```toml
[project]
dependencies = [
    "fluxfast>=0.8.0,<0.9.0",
]
```

In `package.json`:

```json
{
  "dependencies": {
    "@fluxfast/core": "^0.8.0",
    "@fluxfast/next": "^0.8.0"
  }
}
```

Run your package manager install commands:

```bash
# Python
pip install -U fluxfast

# JavaScript
pnpm install # or npm install / yarn install / bun install
```

### 2. Regenerate contracts and validators

Python 0.8 emits `fluxfast-schema/2` manifests. Regenerate frontend contracts
using the full-stack helper:

```bash
fluxfast types backend.main:app --frontend frontend
```

Or from the frontend directory:

```bash
npx fluxfast generate
```

The generator will output:
- `src/.fluxfast/schema.generated.json` (schema/2 format)
- `src/.fluxfast/types.generated.ts` (models, general types, mutation bodies)
- `src/.fluxfast/validators.generated.ts` (native runtime validators)
- `src/.fluxfast/routes.generated.ts` (typed URL builders)
- `src/.fluxfast/mutations.generated.ts` (mutation helpers)
- `src/.fluxfast/pages.generated.ts` (page component registry)

> **Tooling Compatibility Note:** `@fluxfast/next` 0.8 can read both
> `fluxfast-schema/1` and `fluxfast-schema/2` manifests. However, legacy 0.7
> JavaScript tooling cannot read `fluxfast-schema/2` manifests and will exit with
> a diagnostic advising an upgrade of `@fluxfast/next`.

### 3. Replace dummy resources with general application contracts

If your 0.7 application declared dummy resources solely to export TypeScript
types for components or utilities, replace them with `flux.define_type()`:

```python
# Before (0.7 workaround using unused resource):
# USER_MODEL = flux.define_resource("unused_user", User)

# After (0.8 clean general contract):
USER = flux.define_type("User", User, mode="serialization")
CREATE_USER = flux.define_type(
    "CreateUserInput",
    CreateUserInput,
    mode="validation",
)
```

- Use `mode="serialization"` (default) for contracts describing server output.
- Use `mode="validation"` for contracts describing client input (forms, mutations).

### 4. Reuse mutation request body interfaces

In 0.7, mutation request bodies were defined as inline type literals inside
`mutations.generated.ts`. In 0.8, mutation bodies generate reusable named
interfaces in `types.generated.ts`:

```python
class CreateRoomInput(BaseModel):
    number: str
    floor: int


@flux.mutation("/hotels/{hotel_id}/rooms", name="create_room")
async def create_room(hotel_id: int, body: CreateRoomInput):
    ...
```

Frontend usage before:

```ts
// 0.7: Inline body type, hard to reuse in standalone components or forms
await mutations.createRoom(router, {
  params: { hotel_id: 42 },
  body: { number: "101", floor: 1 },
});
```

Frontend usage now:

```tsx
// 0.8: Import and reuse the named body contract
import type { CreateRoomBody } from "@/.fluxfast/types.generated";
import { CreateRoomBodyValidator } from "@/.fluxfast/validators.generated";
import { useForm } from "@fluxfast/next";

export function RoomForm() {
  const form = useForm<CreateRoomBody>(
    { number: "", floor: 1 },
    { validator: CreateRoomBodyValidator }
  );
  // ...
}
```

### 5. Replace third-party client validation schemas

If you maintained duplicate Zod, Valibot, or Yup schemas to validate forms on the
client, you can replace them with FluxFast's native generated validators:

```tsx
// Before (manual Zod duplicate):
// import { z } from "zod";
// const schema = z.object({ name: z.string().min(2), email: z.string().email() });

// After (native FluxFast validator):
import { CreateUserInputValidator } from "@/.fluxfast/validators.generated";

const result = CreateUserInputValidator.validate(formData);
if (!result.valid) {
  console.error(result.issues);
}
```

FluxFast validators have zero runtime dependencies and are tree-shaken if unused.

### 6. Upgrade `useForm` validation

Connect generated validators to `useForm` for instant client-side validation:

```tsx
import { useForm } from "@fluxfast/next";
import { CreateUserInputValidator } from "@/.fluxfast/validators.generated";

const form = useForm(
  { name: "", email: "" },
  { validator: CreateUserInputValidator }
);
```

- **Pre-submit validation:** `form.submit(url)` validates automatically before
  sending network requests. Invalid forms send **zero HTTP requests**.
- **Structured error state:**
  - `form.errors`: Top-level field errors (e.g., `form.errors.email`).
  - `form.issues`: Full structured `readonly ValidationIssue[]` array.
  - `form.errorMap`: Dot/bracket notation error mapping (e.g.,
    `form.errorMap["addresses[0].city"]`).
- **Seamless server merging:** Server 422 errors merge into `form.errors` and
  `form.errorMap` automatically.

### 7. Run `doctor` and check CI drift detection

Run `npx fluxfast doctor` inside your frontend to verify your configuration:

```bash
npx fluxfast doctor
```

`doctor` will check packages, Next.js catch-all routes, page components,
manifest versions, naming collisions, and validator plans.

In your CI pipeline, verify that generated code is current without modifying files:

```bash
fluxfast types backend.main:app --frontend frontend --check
```

---

## Backward Compatibility Guarantees

- **Browser Wire Protocol:** Stays `fluxfast/1`. No client transport changes are
  required.
- **Generated Types Imports:** Imports from `@/.fluxfast/types.generated`
  (`resourceKeys`, `FluxResourceMap`, typed resource interfaces) continue to work
  without modification.
- **Resource Loaders & Caching:** Resource loaders, scopes, live invalidations,
  and distributed Redis cache behavior are completely unaffected.
- **Runtime Mixed Versions:** Mixed versions (`0.8` Python with `0.7` JavaScript,
  and `0.7` Python with `0.8` JavaScript) continue to be tested and supported for
  safe phased deployments.
