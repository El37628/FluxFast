# @fluxfast/codegen

Framework-neutral contract and project code generation for FluxFast.

This package is under **unreleased v1.2 development**. The current published
release is v1.1.0; its Next.js generator already works and does not require this
new package. The workspace version remains synchronized while Phase A is built.

Codegen owns schema parsing, TypeScript contract/route/mutation compilation,
validation-plan compilation, read-only drift checks, and safe artifact writing.
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
Next.js bytes. Next still owns registry rendering in this extraction step;
Codegen can safely persist an adapter-prepared registry snapshot.

See the [Codegen API guide](https://github.com/El37628/FluxFast/blob/main/docs/codegen-api.md)
for complete generation/check examples, diagnostics, and every public export.
