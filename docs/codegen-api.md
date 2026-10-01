# Codegen API

`@fluxfast/codegen` is the Node.js, framework-neutral compiler package being
introduced in **unreleased v1.2**. It is not part of the published v1.1.0 payload.
Do not install `@fluxfast/codegen@1.1.0` from npm: the workspace's synchronized
development version is not a publication claim.

Ordinary Next.js projects should continue using `fluxfast generate`,
`fluxfast types APP`, and the existing `@fluxfast/next/generate` API. Their
arguments and output remain unchanged. This lower-level package is for adapter
authors and tooling that must compile a FastAPI-owned manifest without installing
React or Next.js. It does not define backend routes or replace runtime validation.

The root export is the only public entry point. All exports below are classified
as **Advanced Stable upon v1.2 publication**. Internal compiler modules, naming
helpers, filesystem helpers, and private deep imports are not public APIs.

## Compile without writing files

Export the manifest from the authoritative FastAPI application first:

```sh
fluxfast schema backend:app --output backend-schema.json
```

Then a Node.js tool can inspect or compile it. This example requires the local
v1.2 source build, not the published v1.1 packages:

```js
import fs from "node:fs";
import {
  parseFluxFastSchemaManifest,
  compileFluxFastResourceTypes,
  compileFluxFastValidatorsWithDiagnostics,
  compileFluxFastPageRoutes,
  compileFluxFastMutations,
} from "@fluxfast/codegen";

const manifest = parseFluxFastSchemaManifest(
  fs.readFileSync("backend-schema.json", "utf8"),
);
const types = compileFluxFastResourceTypes(manifest);
const validation = compileFluxFastValidatorsWithDiagnostics(manifest);
const routes = compileFluxFastPageRoutes(manifest);
const mutations = compileFluxFastMutations(manifest);

console.log(typeof types, typeof routes, typeof mutations);
// string string string — each is deterministic TypeScript source.
console.log(validation.contracts);
// e.g. ["RegistrationInput", "CreateRoomBody"] for supported input contracts.
console.log(validation.diagnostics);
// [] when every contract is supported; otherwise precise contract/path reasons.
```

Diagnostics never mean an unsupported contract received a weaker validator.
That contract's validator is omitted; its TypeScript type remains available,
and FastAPI still validates every actual request. Strict
`compileFluxFastValidators(manifest)` throws instead of reporting omissions.

## Build a native validation plan

```js
import { compileJsonSchemaToValidationPlan } from "@fluxfast/codegen";

console.log(compileJsonSchemaToValidationPlan({ type: "string", minLength: 2 }));
// { root: { kind: "string", minLength: 2 } }
```

This returns plan data, not a validation result. An application uses Core's
native validation runtime to evaluate a value against the plan. Generation
itself does not execute the Core runtime.

## Generate and check a project

Codegen's shared scanner renders a registry from the adapter's explicit runtime
target. The adapter selects its exports; Codegen owns scanning, rendering,
artifact compilation, and replacement safeguards. For a Next project, keep the
higher-level Next API; it supplies the unchanged Next target automatically.
This lower-level example scans existing frontend page modules:

```js
import fs from "node:fs";
import path from "node:path";
import {
  createPagesRegistrySnapshot,
  generateFluxFastProject,
  checkFluxFastProject,
} from "@fluxfast/codegen";

const generatedDir = path.resolve("src/.fluxfast");
const registry = createPagesRegistrySnapshot({
  pagesDir: "src/flux-pages",
  outputFile: path.join(generatedDir, "pages.generated.ts"),
  target: {
    runtimeImport: "@fluxfast/next",
    rootExport: "FluxRoot",
    applicationPropsExport: "FluxApplicationProps",
    clientDirective: true,
  },
});
const options = {
  registry,
  generatedDir,
  schemaContent: fs.readFileSync("backend-schema.json", "utf8"),
  log: false,
};

const result = generateFluxFastProject(options);
console.log(result.generatedFiles.map(file => path.basename(file)));
// ["pages.generated.ts", "types.generated.ts", "validators.generated.ts",
//  "routes.generated.ts", "mutations.generated.ts"]
console.log(path.basename(result.registryPath));
// pages.generated.ts — also available directly as registryPath.
console.log(path.basename(result.schemaFile));
// schema.generated.json — persisted schema is reported separately.

const check = checkFluxFastProject(options);
console.log(check.current, check.staleFiles);
// true []
```

If `src/flux-pages/home/index.tsx` exists, `registry.identifiers` includes
`"home/index"`, and its registry entry lazy-loads that allowlisted module. The
snapshot contains source text and resolved paths but creates no files or
directories. An absent source directory returns an empty registry without
creating it. Test/spec/story files and private `_`-prefixed basenames are omitted;
nested symlinks are not followed. Unsafe page paths and duplicate identifiers
are rejected. No backend URL, credentials, or authorization decision belongs
in this registry.

## Select an explicit registry target

The shared scanner has no built-in `@fluxfast/next` target. The following is
an illustrative **React-style host contract**, not an additional released adapter:

```ts
import { createPagesRegistrySnapshot } from "@fluxfast/codegen";
import type { FluxPageRegistryTarget, PagesRegistryOptions } from "@fluxfast/codegen";

const target: FluxPageRegistryTarget = {
  runtimeImport: "@acme/host-runtime",
  rootExport: "ApplicationRoot",
  applicationPropsExport: "ApplicationInput",
  clientDirective: false,
};
const options: PagesRegistryOptions = {
  pagesDir: "src/flux-pages",
  outputFile: "src/.fluxfast/pages.generated.ts",
  target,
};
const registry = createPagesRegistrySnapshot(options);
console.log(registry.identifiers);
// e.g. ["home/index"] for one registered home/index.tsx page.
```

The generated module imports `ApplicationRoot as FluxRoot` and
`ApplicationInput as FluxApplicationProps` from the selected runtime; it keeps
the generated `fluxPages`, `FluxApplication`, and default registry names stable.
The runtime must also export the `ComponentRegistry` type. Its root receives the
application props with `registry` fixed to the generated allowlist. This template
still emits a React `createElement` wrapper; a target alone does not create a
Vue/Svelte renderer or satisfy the rest of an adapter's lifecycle contract.

`clientDirective: true` adds `"use client";`; false or omission leaves it out.
`runtimeImport` must be a non-empty string without control characters and is
serialized as module-specifier data. Generated string literals also escape HTML
delimiters and Unicode line separators while preserving their decoded values.
Root and props export names must be ASCII
JavaScript identifiers; names that would collide with generated locals are
aliased. All target fields are build-tool configuration, not server-selected
page data. Missing or malformed targets throw before scanning or writing.

Omitted `pagesDir` and `outputFile` use `src/flux-pages` and
`src/.fluxfast/pages.generated.ts`, resolved against the current working directory.
The shared constructor requires a target; the existing
`@fluxfast/next/generate` constructor keeps its optional options and Next defaults.

`checkFluxFastProject` compares expected bytes and reports absolute paths for
missing or stale files. It never creates directories, rewrites schema files,
or replaces artifacts. All schema-backed output compiles before generation's
first write. Replacements are atomic **per file**, not a transaction across all
six files. Destinations must stay inside the selected output directory;
symlink traversal and unsafe temporary-file replacement are rejected. See the
[generated artifact contract](generated-artifacts.md) for full safety semantics.

## Public export inventory

These fragments assume `manifest`, `options`, `validation`, `result`, `check`, and `error`
exist as in the examples above. Types describe data; they do not create a runtime
object or perform an operation.

<!-- codegen-api-examples:start -->
| Export | Declaration or use | Purpose |
| --- | --- | --- |
| `parseFluxFastSchemaManifest` | `const manifest = parseFluxFastSchemaManifest(json);` | Parses and validates exported schema/1 or schema/2 JSON. |
| `validateFluxFastSchemaManifest` | `const manifest = validateFluxFastSchemaManifest(value);` | Validates an already-parsed unknown value. |
| `FluxFastSchemaManifest` | `const manifest: FluxFastSchemaManifest = validateFluxFastSchemaManifest(value);` | Types the validated schema contract. |
| `JsonSchema` | `const schema: JsonSchema = { type: "string" };` | Types the supported JSON Schema input object. |
| `SchemaManifestValidationError` | `if (error instanceof SchemaManifestValidationError) console.error(error.path);` | Identifies a closed-shape or schema-manifest validation failure. |
| `compileFluxFastResourceTypes` | `const source = compileFluxFastResourceTypes(manifest);` | Produces deterministic application/resource/mutation TypeScript types. |
| `findFluxFastContractsWithUnknownTypes` | `const names = findFluxFastContractsWithUnknownTypes(manifest);` | Reports root contracts that compile to unknown types. |
| `findFluxFastResourceKeysWithUnknownTypes` | `const keys = findFluxFastResourceKeysWithUnknownTypes(manifest);` | Reports resources whose generated type includes unknown. |
| `findFluxFastSchemaModeConflicts` | `const conflicts = findFluxFastSchemaModeConflicts(manifest);` | Reports validation/serialization contracts with colliding normalized names. |
| `SchemaCompilationError` | `if (error instanceof SchemaCompilationError) console.error(error.path);` | Identifies a deterministic compiler error at one schema location. |
| `compileFluxFastPageRoutes` | `const source = compileFluxFastPageRoutes(manifest);` | Produces named frontend builders for backend-owned page routes. |
| `compileFluxFastMutations` | `const source = compileFluxFastMutations(manifest);` | Produces typed helpers for backend-owned JSON mutation routes. |
| `compileFluxFastValidators` | `const source = compileFluxFastValidators(manifest);` | Compiles validators strictly; unsupported contracts cause an error. |
| `compileFluxFastValidatorsWithDiagnostics` | `const result = compileFluxFastValidatorsWithDiagnostics(manifest);` | Produces supported validators and explicit unsupported-contract diagnostics. |
| `compileJsonSchemaToValidationPlan` | `const plan = compileJsonSchemaToValidationPlan({ type: "string" });` | Produces native Core validation-plan data from one JSON Schema. |
| `ValidatorCompilationError` | `if (error instanceof ValidatorCompilationError) console.error(error.keyword);` | Identifies validator-specific failures without weakening validation. |
| `ValidatorCompilationDiagnostic` | `const diagnostic: ValidatorCompilationDiagnostic \| undefined = validation.diagnostics[0];` | Types one omitted contract's path, reason, and optional keyword. |
| `ValidatorCompilationOptions` | `const policy: ValidatorCompilationOptions = { unsupported: "report" };` | Selects strict failure or explicit unsupported-contract reporting. |
| `ValidatorCompilationResult` | `const validation: ValidatorCompilationResult = compileFluxFastValidatorsWithDiagnostics(manifest);` | Types generated source, supported contract names, and diagnostics. |
| `FluxPageRegistryTarget` | `const target: FluxPageRegistryTarget = { runtimeImport: "@acme/host-runtime", rootExport: "ApplicationRoot", applicationPropsExport: "ApplicationInput" };` | Selects the runtime module, root/props exports, and optional client directive. |
| `PagesRegistryOptions` | `const input: PagesRegistryOptions = { target, pagesDir: "src/flux-pages" };` | Supplies source/output paths and the required adapter target. |
| `createPagesRegistrySnapshot` | `const registry = createPagesRegistrySnapshot({ target, pagesDir: "src/flux-pages" });` | Scans modules and renders the targeted allowlist without file writes. |
| `PagesRegistrySnapshot` | `const registry: PagesRegistrySnapshot = options.registry;` | Types registry content, scanned files, identifiers, and resolved paths. |
| `FluxFastGenerationOptions` | `const input: FluxFastGenerationOptions = options;` | Supplies registry, schema input, output directory, and logging policy. |
| `generatePagesRegistry` | `generatePagesRegistry(options.registry, { log: false });` | Safely replaces only the adapter-supplied registry. |
| `generateFluxFastProject` | `const result = generateFluxFastProject(options);` | Compiles and safely persists the full artifact set. |
| `FluxFastGenerationResult` | `const written: FluxFastGenerationResult = generateFluxFastProject(options);` | Types paths, generated validator names, and diagnostics after generation. |
| `checkFluxFastProject` | `const check = checkFluxFastProject(options);` | Reports deterministic drift without any file writes. |
| `FluxFastGenerationCheckResult` | `const status: FluxFastGenerationCheckResult = checkFluxFastProject(options);` | Types current/stale status, checked paths, and validator diagnostics. |
<!-- codegen-api-examples:end -->
