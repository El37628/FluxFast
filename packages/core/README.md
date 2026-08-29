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
import { FluxRouter, ResourceStore } from "@fluxfast/core";
```

`@fluxfast/core` has no React, Next.js, Vue, Svelte, or Solid dependency. It
supports Node.js 22 and 24, while the browser-facing APIs target modern web
runtimes.

See the [FluxFast architecture](https://github.com/El37628/FluxFast/blob/main/docs/architecture.md),
[wire protocol](https://github.com/El37628/FluxFast/blob/main/docs/protocol.md),
and [versioning policy](https://github.com/El37628/FluxFast/blob/main/docs/versioning.md)
for the public contracts.

FluxFast is licensed under the [MIT License](https://github.com/El37628/FluxFast/blob/main/LICENSE).
