# @fluxfast/core

Framework-neutral browser runtime for the FluxFast protocol. It provides the
resource store, router, transport, cache, mutation, history, event, and
prefetch primitives shared by frontend adapters.

Most applications should install an adapter such as `@fluxfast/next`, which
installs a compatible version of this package automatically. Install the core
package directly when building an adapter or using its framework-neutral APIs:

```bash
npm install @fluxfast/core
```

```ts
import {
  FluxRouter,
  ResourceStore,
  createValidator,
  refineValidator,
  formatValidationPath,
  type FluxValidator,
  type ValidationResult,
  type ValidationIssue,
} from "@fluxfast/core";
```

`@fluxfast/core` includes the framework-neutral, dependency-free runtime
validation engine used by `@fluxfast/next`'s generated validators. It supports
reusable schemas, structured issues, dot/bracket path formatting, bounded
evaluation limits, and synchronous refinements with zero external dependencies.

`@fluxfast/core` has no React, Next.js, Vue, Svelte, or Solid dependency. It
supports Node.js 22 and 24, while the browser-facing APIs target modern web
runtimes.

Unreleased v1.2 foundation work adds server adapter primitives through
`@fluxfast/core/server`, separately from this browser-facing root. The initial
surface provides `selectFluxForwardHeaders` and `removeFluxHopByHopHeaders`;
it does not require a change to existing Next.js applications. This subpath is
not present in the published v1.1 package. See the
[Core API inventory](https://github.com/El37628/FluxFast/blob/main/docs/core-api.md#server-adapter-primitives-unreleased-v12)
for the supported inputs, outputs, and security boundaries.

See the [FluxFast architecture](https://github.com/El37628/FluxFast/blob/main/docs/architecture.md),
[native client validation](https://github.com/El37628/FluxFast/blob/main/docs/validation.md),
[wire protocol](https://github.com/El37628/FluxFast/blob/main/docs/protocol.md),
and [versioning policy](https://github.com/El37628/FluxFast/blob/main/docs/versioning.md)
for the public contracts.

FluxFast is licensed under the [MIT License](https://github.com/El37628/FluxFast/blob/main/LICENSE).
