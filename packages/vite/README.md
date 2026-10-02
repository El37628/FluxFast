# @fluxfast/vite

Same-origin React SSR host and Vite tooling introduced in FluxFast 1.2. Match
Python, Core, Codegen, React and Vite package versions; see the
[release notes](https://github.com/El37628/FluxFast/blob/main/docs/releases/v1.2.0.md)
for installation and availability. Existing Next applications keep their adapter.

Vite owns compilation, lazy chunks and development HMR. The host serves actual
React SSR documents, browser assets and FluxFast protocol traffic on one public
origin. FastAPI remains private and owns application routes and resources.
Production imports a built Node renderer without loading Vite or source config.

After installing matching Core, Codegen, React and Vite packages and declaring
the React/React DOM/Vite peers in your frontend, initialize with the local binary:

```sh
npm exec --no -- fluxfast-vite init --dry-run
npm exec --no -- fluxfast-vite init --yes
npm exec --no -- fluxfast-vite init --check
npm exec --no -- fluxfast-vite doctor
```

This preserves your SPA entries, source Vite config, custom scripts and user
agent instructions. It adds a dedicated `fluxfast.vite.config.mjs`, separate SSR
template, starter page, generated React registry/agent knowledge, bounded
`AGENTS.md`/`CLAUDE.md` references, and scoped `fluxfast:dev`, `fluxfast:build`,
`fluxfast:start` scripts. No dependencies are downloaded or configuration executed
by setup/check commands. Export your authoritative backend schema, then use
`fluxfast-vite generate --schema-file PATH` for all six typed artifacts and
`generate --check` for read-only drift detection. Codegen is loaded only for
these tooling commands, not by the production host.

With the matching Python package, run the complete initialized app
from its backend project directory:

```sh
fluxfast types backend.main:app --frontend frontend
fluxfast dev backend.main:app --frontend frontend
fluxfast build --app backend.main:app --frontend frontend
fluxfast doctor --production --app backend.main:app --frontend frontend --strict
fluxfast start backend.main:app --frontend frontend
```

Python detects the declared `@fluxfast/vite` host and runs its scoped scripts,
not your existing SPA scripts. It supervises FastAPI privately and the public
Node host as one service; do not start a second FastAPI service manually.
Production consumes `dist/fluxfast/` and never builds/generates at startup.
Python 1.2+ selects this host; older 1.1 Python does not.

Alternatively configure the host manually:

```ts
// vite.config.ts, after installing the matching packages
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
The shared browser gates run the same contracts as Next in development and
production, plus initialized packed consumers and three-worker Redis tests.
Cold hydration/navigation and automatic source synchronization use one public
origin; production also hydrates without source or build tooling. Publication
gates test the exact archives and then matching registry-only installations.

See the [Vite host guide](https://github.com/El37628/FluxFast/blob/main/docs/vite-host.md)
for template/configuration examples, installation, server APIs, output
ownership and production limitations.
