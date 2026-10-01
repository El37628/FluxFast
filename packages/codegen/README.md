# @fluxfast/codegen

Framework-neutral contract and project code generation for FluxFast.

This package is under **unreleased v1.2 development**. The current published
release is v1.1.0; its Next.js generator already works and does not require this
new package. The workspace version remains synchronized while Phase A is built.

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

See the [Codegen API guide](https://github.com/El37628/FluxFast/blob/main/docs/codegen-api.md)
for complete generation/check examples, diagnostics, and every public export.
