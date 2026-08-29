# @fluxfast/next

Next.js App Router adapter for FluxFast. FastAPI owns application routing,
validation, authentication, and data loading; Next.js supplies the document,
bundling, React runtime, and code splitting.

```bash
npm install @fluxfast/next
```

Wrap the Next config to generate the component allowlist and proxy only
FluxFast protocol requests to the private FastAPI address:

```ts
import { withFluxFast } from "@fluxfast/next/next-config";

export default withFluxFast({
  reactStrictMode: true,
});
```

Page paths may use ASCII letters, digits, `_`, `.`, `@`, parentheses, brackets,
and hyphens, with `/` between directories and a `.tsx` or `.jsx` extension.
The generator rejects other characters before emitting import paths.

Create the optional catch-all shell at
`app/(flux)/[[...flux]]/page.tsx`:

```tsx
import { createFluxNextPage } from "@fluxfast/next/server";
import { fluxConfig } from "@/fluxfast.config";

export default createFluxNextPage(fluxConfig);
```

During development, run the supervisor from the consuming application:

```bash
.venv/bin/fluxfast dev backend.app.main:app
```

The supervisor starts FastAPI on a private available port and Next.js on the
browser-facing port. Browser transport stays same-origin, so no public backend
port or development CORS configuration is required. The supervisor detects
npm, pnpm, Yarn, or Bun from the consuming frontend.

The package supports Next.js `>=16.3.0 <17.0.0`, React 19, and Node.js 22 and
24. See the complete [Next.js adapter guide](https://github.com/El37628/FluxFast/blob/main/docs/nextjs-adapter.md),
[caching guide](https://github.com/El37628/FluxFast/blob/main/docs/caching.md),
and [mutation guide](https://github.com/El37628/FluxFast/blob/main/docs/mutations.md).

FluxFast is licensed under the [MIT License](https://github.com/El37628/FluxFast/blob/main/LICENSE).
