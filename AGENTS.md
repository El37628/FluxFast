# Agent Rules

## Architecture

FastAPI owns application routing and resource definitions.

`packages/core` is framework-neutral. `packages/next` may depend on React and
Next.js. Never make `packages/core` import React, Next.js, Vue, Svelte, or Solid.

## Protocol

Read `docs/protocol.md` before modifying wire types. Do not make incompatible
protocol changes without documenting and versioning them. Protocol versions are
independent of package versions.

## Bug Fixes

Add a regression test before or alongside every non-trivial bug fix. Fix the
owning layer: backend engine, wire protocol, framework-neutral core, adapter, or
consumer application.

## Git Handoff

For every completed task that changes this repository, prepare a local Git
handoff unless the user explicitly asks otherwise:

- Inspect the branch and worktree before making Git changes. Preserve all
  pre-existing user changes and never stage unrelated files.
- When work begins on `main`, `master`, or another default branch, create a
  concise task branch using an appropriate `feat/`, `fix/`, `docs/`, or
  `chore/` prefix. Keep an existing non-default branch when it already matches
  the task.
- Run the relevant verification, stage task-owned paths explicitly, review the
  staged diff, and commit with a concise Conventional Commit message.
- Do not amend, rebase, reset, stash, tag, or otherwise rewrite history unless
  the user explicitly requests it.
- Never push commits or branches. Leave Git pushes to the user and report the
  branch name, commit hash, verification performed, remaining worktree changes,
  and suggested `git push -u origin <branch>` command.
- After the user confirms the branch is pushed, open a pull request against the
  default branch with a concise summary and verification notes. Leave merging
  to the user unless they explicitly ask otherwise.

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
pnpm test:e2e

# Controlled benchmark
pnpm benchmark
```

## Generated Files

Do not manually edit `src/.fluxfast/pages.generated.ts` in consuming projects.
Run `fluxfast generate`.
