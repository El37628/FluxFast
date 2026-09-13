# Agent Rules

## Working approach

Complete the requested outcome: inspect relevant code, implement, verify, review
and fix issues caused by the change, then prepare the Git handoff. Make routine,
reversible local decisions without approval, including edits, development
commands, tests, builds, and fixes. Prefer existing patterns and dependencies;
avoid unrelated refactoring.

Ask only when intent cannot reasonably be inferred for a materially ambiguous
product, architecture, or external-contract decision, or before consequential
actions not already authorized: production deployment, destructive data changes,
credential operations, or irreversible infrastructure changes. The Git rules
below remain explicit boundaries for repository operations.

Read context on demand, starting with the owning layer and nearby tests. No
mandatory full-repository exploration or plan is needed for routine work. For
long tasks, retain concise findings, decisions, verification, and remaining work
so continuation does not require restarting the investigation.

## Architecture

FastAPI owns application routing, resource definitions, authentication,
authorization, and runtime validation. The frontend registry maps server-selected
component identifiers to allowlisted UI modules.

`packages/core` is framework-neutral. `packages/next` may depend on React and
Next.js. Never make `packages/core` import React, Next.js, Vue, Svelte, or Solid.

## Protocol

Read `docs/protocol.md` before modifying wire types. Do not make incompatible
protocol changes without documenting and versioning them. Protocol versions are
independent of package versions.

## Context and verification

Use these references when the task touches their subject, not as a reading list:

- Ownership and cross-layer behavior: `docs/architecture.md` and the relevant
  record in `docs/decisions/`.
- Wire changes: `docs/protocol.md`; developer schema/code generation:
  `docs/developer-schema.md`, `docs/generated-artifacts.md`, `docs/type-safety.md`.
- Cache isolation and workers: `docs/caching.md`, `docs/distributed-cache.md`;
  live synchronization: `docs/live-resources.md`, `docs/live-deployment.md`.
- Adapter integration: `docs/nextjs-adapter.md`; deployment/runtime:
  `docs/production.md`, `docs/containers.md`.
- Public compatibility and releases: `docs/stability.md`, `docs/versioning.md`,
  `docs/releasing.md`. The local, ignored `NEXT_PHASE.md`, when present, is a
  v1.0 release work plan; consult its relevant phase only for release work.
- Setup and focused commands: `CONTRIBUTING.md`. Package scripts, Python config,
  TypeScript config, and `.github/workflows/` define tooling and CI requirements.

Fix the owning layer: backend engine, wire protocol, framework-neutral core,
adapter, or consumer application. Add a regression test before or alongside
every non-trivial bug fix; do not add tests for trivial implementation details.
Start with focused checks and broaden for shared infrastructure, cross-layer
contracts, risky behavior, failures, or unresolved uncertainty. Documentation-only
changes need reference and diff review, not runtime suites. Local test selection
does not waive required CI or release gates.

Completion includes relevant passing checks (or an explicit blocker), review of
the final diff for unintended behavior and compatibility changes, and a concise
handoff stating what changed, verification, and any remaining limitations.

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
  default branch with a concise summary and verification notes. Monitor every
  required check and do not bypass branch protection or merge while a required
  check is queued, running, skipped, cancelled, or failing.
- When all required checks pass, merge the pull request using the repository's
  normal merge strategy unless the user asks to merge it themselves. Then
  switch to the default branch, update it with `git pull --ff-only`, and report
  the merged pull request and synchronized commit. If a check fails, diagnose
  it and prepare the fix on the task branch instead of merging.

## Performance

Performance claims require repeatable benchmarks. Record the baseline, workload,
result, tradeoff, and correctness checks.

## Cache Safety

Never cache user or tenant resources without an explicit cache scope. Consider
public, per-user, per-tenant, anonymous/authenticated transitions, logout, and
multiple FastAPI workers for every cache change.

## Generated Files

Do not manually edit consuming projects' `.fluxfast` generated artifacts,
including `src/.fluxfast/pages.generated.ts`. Change the authoritative inputs
or generator and regenerate with `fluxfast generate` or the project's generation
script; use `docs/generated-artifacts.md` for typed artifacts and drift checks.
