# @fluxfast/vite

Same-origin React SSR host and Vite tooling for FluxFast, under **unreleased v1.2
development**. Published v1.1 applications still use the Next.js adapter.
The workspace version stays synchronized; this package is not published yet.

Vite owns compilation, lazy chunks and development HMR. The host serves actual
React SSR documents, browser assets and FluxFast protocol traffic on one public
origin. FastAPI remains private and owns application routes and resources.
Production imports a built Node renderer without loading Vite or source config.

```ts
// vite.config.ts, after installing the source-built packages
import { defineConfig } from "vite";
import { fluxfast } from "@fluxfast/vite";

export default defineConfig({ plugins: [fluxfast()] });
```

The plugin defaults to `src/.fluxfast/pages.generated.ts` (`FluxApplication`) and
`fluxfast.html`. Use `fluxfast-vite dev`, `fluxfast-vite build`, and
`fluxfast-vite start`, not the SPA `vite`/`vite preview` commands.
The development server and HMR share the public port. Production serves only
allowlisted client build files and never exposes the SSR template or renderer.

Supported tooling: Node 22.12+ or 24, Vite `>=7.3.6 <8`, React/React DOM 19+.
The framework-neutral runtime does not depend on this host.
Initialization, Python React adapter selection and the complete browser
conformance gates remain separate unreleased integration work.

See the [Vite host guide](https://github.com/El37628/FluxFast/blob/main/docs/vite-host.md)
for template/configuration examples, source-build usage, server APIs, output
ownership and production limitations.
