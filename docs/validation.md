# Native Client Validation

FluxFast 0.8 provides a first-party, dependency-free runtime validation system.
Validation plans are compiled directly from authoritative Python and Pydantic
contracts into `@/.fluxfast/validators.generated.ts`.

Developers do not need to install or maintain Zod, Valibot, Yup, Joi, or AJV
for ordinary application validation.

```text
Python / Pydantic Contract
          ↓
fluxfast types / fluxfast generate
          ↓
@/.fluxfast/validators.generated.ts
          ↓
@fluxfast/core runtime validator (0 dependencies)
          ↓
useForm / presentation components / client state
```

---

## Core principles

### 1. Client validation is UX, not security authority

Client validation gives immediate feedback in the browser and prevents invalid
network requests. It is not an authorization or security boundary. FastAPI and
Pydantic remain the authoritative backend validators for all business logic,
security checks, and persisted state.

### 2. Zero third-party validation dependencies

FluxFast validators run entirely on a lightweight evaluator built into
`@fluxfast/core`. Consuming applications require no external schema packages.

### 3. No double-validation of server responses

Typed resources emitted by FastAPI are already validated and serialized on the
server. FluxFast does not automatically re-validate received resources in the
browser, avoiding redundant client-side CPU overhead. Native validators are
designed for:
- Form inputs
- Mutation payloads
- Client-side application data
- Local storage and persisted state
- External API boundaries

---

## The validator API

Generated validators implement the `FluxValidator<T>` interface from `@fluxfast/core`:

```ts
export interface FluxValidator<T> {
  /** Validate a value and return structured issues without throwing. */
  validate(value: unknown): ValidationResult<T>;

  /** Type guard that returns true if the value matches the contract. */
  is(value: unknown): value is T;

  /** Return the validated value, or throw a ValidationError with all issues. */
  assert(value: unknown): T;
}
```

### Validation results and issues

The result of calling `validator.validate(data)` is a discriminated union:

```ts
export type ValidationResult<T> =
  | {
      valid: true;
      value: T;
      issues: readonly [];
    }
  | {
      valid: false;
      issues: readonly ValidationIssue[];
    };
```

Each `ValidationIssue` contains:

| Property | Type | Description |
| --- | --- | --- |
| `path` | `readonly (string \| number)[]` | Array of keys or array indices indicating where the error occurred |
| `code` | `string` | Canonical machine-readable error code (e.g., `invalid_type`, `string_too_short`) |
| `message` | `string` | Human-readable error description |

Use `formatValidationPath(issue.path)` from `@fluxfast/core` to format path arrays
into standard JavaScript dot/bracket notation (e.g., `users[0].contact.email`).

---

## Quick example

### 1. Define the contract in Python

```python
from pydantic import BaseModel, EmailStr, Field
from fluxfast import FluxFast


class RegistrationInput(BaseModel):
    name: str = Field(min_length=2, max_length=50)
    email: EmailStr
    age: int = Field(ge=18)


flux.define_type(
    "RegistrationInput",
    RegistrationInput,
    mode="validation",
)
```

### 2. Generate contracts and validators

```bash
fluxfast types backend.main:app --frontend frontend
```

### 3. Use in your frontend

```ts
import type { RegistrationInput } from "@/.fluxfast/types.generated";
import { RegistrationInputValidator } from "@/.fluxfast/validators.generated";

const input: unknown = {
  name: "Alice",
  email: "invalid-email",
  age: 16,
};

const result = RegistrationInputValidator.validate(input);

if (!result.valid) {
  for (const issue of result.issues) {
    console.error(issue.path.join("."), issue.message);
  }
} else {
  // result.value is strongly typed as RegistrationInput
  console.log("Valid input:", result.value.name);
}
```

---

## Generated validators (`validators.generated.ts`)

When `fluxfast types` or `fluxfast generate` runs, it outputs
`@/.fluxfast/validators.generated.ts` containing:

- **Type contract validators:** Any type declared with `flux.define_type()` produces
  a matching `${Name}Validator`.
- **Resource validators:** Declared typed resources produce matching resource
  validators.
- **Mutation body validators:** Mutations with JSON body schemas produce
  `${PascalCaseName}BodyValidator` instances.

### Pure construction and tree-shaking

Validator factories are marked as pure:

```ts
export const RegistrationInputValidator = /* @__PURE__ */ createValidator<RegistrationInput>({
  kind: "object",
  properties: { ... },
});
```

If your application only imports `RegistrationInputValidator`, unused validators
and their static validation plans are eliminated during production bundling.
Applications that do not import any validators incur zero runtime validation
overhead.

---

## Supported validation constraints

FluxFast compiles JSON Schema constraints emitted by Pydantic:

### Strings
- `minLength`, `maxLength`
- `pattern` (regular expressions evaluated safely)
- Formats:
  - `email`
  - `uuid`
  - `date-time`, `date`, `time`
  - `uri`
  - `ipv4`, `ipv6`
  - `hostname`

### Numbers & integers
- `minimum`, `maximum`
- `exclusiveMinimum`, `exclusiveMaximum`
- `multipleOf`
- `integer` checks

### Objects
- `properties` and `required` fields
- `additionalProperties` (enforces strict schema boundaries when configured)
- Nested object evaluation

### Arrays
- `items` element validation
- `minItems`, `maxItems`
- `uniqueItems`

### Unions, literals, and enums
- `anyOf` / `oneOf` unions
- Literal constants
- Enumerations
- Nullable and optional fields

### Recursive and self-referencing types
Hierarchical models (such as comment trees, category hierarchies, or organization
charts) use local schema definitions (`$defs`) and are evaluated safely without
infinite recursion.

### Unsupported keywords
If a Pydantic contract produces schema keywords that the client evaluator cannot
safely verify, the code generator emits an explicit diagnostic. Unsupported
semantics are never silently dropped.

---

## Runtime safety and denial-of-service prevention

The validator evaluator includes defensive runtime protections:

1. **Recursion depth limits:** Evaluator traversal is bounded (`maxDepth: 32` by
   default) to protect against deep or self-referencing inputs.
2. **Operation bounds:** Total evaluation steps are tracked (`maxOperations: 50,000`
   by default) to prevent CPU starvation from hostile combinatorial inputs.
3. **Issue limits:** Traversal caps the number of collected issues (`maxIssues: 100`
   by default) to avoid unbounded memory allocation.
4. **Prototype pollution immunity:** The evaluator safely ignores internal
   JavaScript properties such as `__proto__`, `constructor`, and `prototype`.
5. **Cycle detection:** Hostile cyclic JavaScript objects are detected without
   causing browser stack overflow errors.

---

## Synchronous validator refinements

To implement business rules that cross multiple fields (such as checking that a
confirmation password matches), use `refineValidator()`:

```ts
import { refineValidator } from "@fluxfast/core";
import { RegisterInputValidator } from "@/.fluxfast/validators.generated";

export const ValidatedRegister = refineValidator(
  RegisterInputValidator,
  (value) => {
    if (value.password !== value.confirmPassword) {
      return {
        path: ["confirmPassword"],
        code: "custom",
        message: "Passwords must match",
      };
    }
    return null; // Valid!
  }
);
```

### Refinement rules
- Refinements run **only after** schema validation succeeds, so `value` is guaranteed
  to be typed and structurally valid.
- Refinements must be **synchronous**.
- Refinements return a `ValidationIssue`, or `null` / `undefined` when valid.
- Refinements **cannot transform or mutate** values.

FluxFast intentionally does not include an asynchronous refinement system or a
heavy schema-builder DSL. Async checks (such as verifying email uniqueness in a
database) belong on the FastAPI backend where authorization and transactions can be
safely applied.

---

## Form integration with `useForm`

`@fluxfast/next` provides native integration between `useForm` and FluxFast
validators:

```tsx
"use client";

import { useForm } from "@fluxfast/next";
import type { CreateUserInput } from "@/.fluxfast/types.generated";
import { CreateUserInputValidator } from "@/.fluxfast/validators.generated";

export function RegistrationForm() {
  const form = useForm<CreateUserInput>(
    {
      name: "",
      email: "",
      age: 18,
    },
    {
      validator: CreateUserInputValidator,
    }
  );

  return (
    <form onSubmit={form.submit("/api/users")}>
      <div>
        <label>Name</label>
        <input
          value={form.data.name}
          onChange={(e) => form.setData("name", e.target.value)}
        />
        {form.errors.name && <span className="error">{form.errors.name}</span>}
      </div>

      <div>
        <label>Email</label>
        <input
          value={form.data.email}
          onChange={(e) => form.setData("email", e.target.value)}
        />
        {form.errors.email && <span className="error">{form.errors.email}</span>}
      </div>

      <button type="submit" disabled={form.processing}>
        {form.processing ? "Registering..." : "Register"}
      </button>
    </form>
  );
}
```

### How `useForm` validation behaves

1. **Pre-submit validation:** When the user submits the form, `useForm` runs the
   validator synchronously before sending an HTTP request. If the data is invalid,
   **zero network requests are sent**, and `form.errors`, `form.issues`, and
   `form.errorMap` are populated immediately.
2. **Manual validation:** You can trigger validation anytime by calling
   `const isValid = form.validate()`.
3. **Structured error state:**
   - `form.errors`: Top-level field errors for convenient single-level form bindings
     (e.g., `form.errors.email`).
   - `form.issues`: The complete, structured `readonly ValidationIssue[]` array.
   - `form.errorMap`: A frozen dictionary mapping formatted string paths to error
     messages (e.g., `form.errorMap["addresses[0].zip"]`).
4. **Server validation coexistence:** If client-side validation passes, the request
   proceeds to FastAPI. Any 422 validation errors or custom error envelopes returned
   by the server are merged into `form.errors` and `form.errorMap` automatically.
5. **Selective error clearing:** Calling `form.clearErrors("email")` clears errors
   for that field while preserving other validation feedback.
