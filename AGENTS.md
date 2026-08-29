# Agent Rules

## Architecture

FastAPI owns application routing and resource definitions.

`packages/core` is framework-neutral. `packages/next` may depend on React and
Next.js. Never make `packages/core` import React, Next.js, Vue, Svelte, or Solid.

The companion application lives in the sibling `../fluxfast-example` project;
do not move it back into this repository or add it to this workspace.

## Protocol

Read `docs/protocol.md` before modifying wire types. Do not make incompatible
protocol changes without documenting and versioning them. Protocol versions are
independent of package versions.

## Bug Fixes

Add a regression test before or alongside every non-trivial bug fix. Fix the
owning layer: backend engine, wire protocol, framework-neutral core, adapter, or
example.

## Performance

Performance claims require repeatable benchmarks. Record the baseline, workload,
result, tradeoff, and correctness checks.

## Cache Safety

Never cache user or tenant resources without an explicit cache scope. Consider
public, per-user, per-tenant, anonymous/authenticated transitions, logout, and
multiple FastAPI workers for every cache change.

## Commands

```bash
# Python
./.venv/bin/python -m pytest -q python/fluxfast/tests
./.venv/bin/ruff check python/fluxfast

# JavaScript/TypeScript
pnpm install
pnpm typecheck
pnpm test
pnpm build

# Controlled benchmark
pnpm benchmark

# Standalone example and browser tests
cd ../fluxfast-example
npm install
npm run generate
npm run typecheck
npm run build
npm run test:e2e

# One-command application development
.venv/bin/fluxfast dev backend.app.main:app
```

## Generated Files

Do not manually edit `src/.fluxfast/pages.generated.ts` in consuming projects.
Run `fluxfast generate`.
