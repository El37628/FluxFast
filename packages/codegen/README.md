# @fluxfast/codegen

Framework-neutral contract and project code generation for FluxFast.

Introduced in FluxFast 1.2. Existing Next.js generator APIs and commands remain
compatible and delegate to this package. Match its version to your FluxFast
runtime; see the [release notes](https://github.com/El37628/FluxFast/blob/main/docs/releases/v1.2.0.md)
for installation and availability.

Codegen owns schema parsing, TypeScript contract/route/mutation compilation,
validation-plan compilation, adapter-targeted page scanning/registry rendering,
read-only drift checks, and safe artifact writing.
It needs Node.js 22 or 24, not Next.js or React. Core is a declaration dependency;
the compiler does not execute the Core runtime.

```js
import { compileJsonSchemaToValidationPlan } from "@fluxfast/codegen";

const plan = compileJsonSchemaToValidationPlan({
  type: "string",
  minLength: 2,
});
console.log(plan);
// { root: { kind: "string", minLength: 2 } }
```

The existing `@fluxfast/next/generate` imports and `fluxfast generate` command
delegate to Codegen without changing their arguments, results, or generated
Next.js bytes. Next supplies its default registry target; shared scanning,
rendering, and safe persistence live in Codegen. Other tooling must explicitly
select its runtime exports rather than inheriting a hardcoded Next import.

The package also provides a separate binary, without competing for
Next's existing `fluxfast` command:

```sh
fluxfast-codegen generate --adapter next --schema-file backend-schema.json
fluxfast-codegen generate --adapter next --schema-file backend-schema.json --check
fluxfast-codegen generate --adapter react --schema-file backend-schema.json
fluxfast-codegen generate --adapter react --schema-file backend-schema.json --check
```

`next` remains the default and preserves its existing root/src layout. `react`
selects `@fluxfast/react` with no Next client directive; it uses `src/flux-pages`
and `src/.fluxfast` when `src/` exists, or the project-root equivalents otherwise.
The other five artifacts are identical for the same schema. The command discovers
the nearest frontend `package.json`, without executing Next/Vite configuration.
Checks never write files. Exit codes are `0` for generated/current, `1` for
stale files or generation errors, and `2` for invalid usage or unsupported targets.
The React target generates an allowlist, not a Vite server, application router,
or backend connection. Complete React SSR/Vite initialization belongs to the
[Vite host](https://github.com/El37628/FluxFast/blob/main/docs/vite-host.md) and Python CLI.

See the [Codegen API guide](https://github.com/El37628/FluxFast/blob/main/docs/codegen-api.md)
for installation, complete API and CLI examples, diagnostics, and every public export.
