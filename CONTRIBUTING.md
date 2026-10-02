# Contributing

Follow [AGENTS.md](AGENTS.md) for repository invariants and Git handoff. Start in
the owning package and nearby tests; consult architecture records when their
boundary is affected. Prefer existing patterns and keep changes scoped.

## Setup and verification

Use the Node and pnpm versions declared in `package.json` and Python requirements
in `python/fluxfast/pyproject.toml`. Install JavaScript dependencies with
`pnpm install --frozen-lockfile` and Python development dependencies into `.venv`
with `./.venv/bin/python -m pip install -e 'python/fluxfast[dev]'`.

Select checks proportional to the change. Start with the affected test file or
package; broaden when shared behavior, risk, failures, or uncertainty warrant it.
Documentation-only changes normally need link/path and diff review. CI remains
the source of truth for required matrices and integration gates.

| Area | Focused checks from the repository root |
| --- | --- |
| Python engine or CLI | `./.venv/bin/python -m pytest -q python/fluxfast/tests/<test_file>.py`; `./.venv/bin/ruff check python/fluxfast` |
| Core runtime | `pnpm --filter @fluxfast/core exec vitest run tests/<test_file>.test.ts`; `pnpm --filter @fluxfast/core run typecheck` |
| Next adapter or codegen | Build core first with `pnpm --filter @fluxfast/core run build`, then `pnpm --filter @fluxfast/next exec vitest run tests/<test_file>.test.ts` and `pnpm --filter @fluxfast/next run typecheck` |
| Release tooling | `node --test scripts/<test_file>.test.mjs` |
| Schema compatibility | `pnpm test:schema-compatibility` |
| Adapter behavior | `pnpm test:adapter-conformance --grep '<scenario>'`; see [the conformance suite](tests/adapter-conformance/README.md) |

For browser tests, install Chromium once with
`pnpm --dir tests/browser/frontend exec playwright install --with-deps chromium`.
The fixture's scripts handle schema checks and generation. Its local
`AGENTS.md`/`CLAUDE.md` are maintained by Next.js and ignored by Git; consult
installed Next.js guides when changing framework-specific behavior.

`pnpm test:adapter-conformance` runs the shared HTTP/browser contract against the
Next harness. `pnpm test:adapter-conformance:production` also builds the fixture
and checks that production startup and test execution do not modify its inputs.
The existing `test:e2e` and `test:e2e:production` commands remain aliases. DevTools
UI and distributed-worker suites keep their separate commands and CI coverage.

Broader checks are `pnpm test:python`, `pnpm typecheck`, `pnpm test`, `pnpm build`,
and `pnpm test:e2e`. Root TypeScript scripts build workspace dependencies before
checks; focused commands may need those builds too. See `package.json` and
`.github/workflows/` for production, Redis, container, and release-consumer checks.

For Python-to-JavaScript tooling changes, `pnpm test:consumer:types` builds
isolated packed consumers and verifies both upgrade orders against actual
published v1.1.0 packages, including local generator selection, six artifact
bytes, and read-only missing/current/stale checks in root/src layouts. The
release-artifact job runs this gate on its already-verified archives.

Protocol changes must update `docs/protocol.md`; cache changes must include
isolation tests. Performance claims require repeatable benchmark evidence with
a baseline, workload, result, tradeoff, and correctness checks; select the
relevant `benchmark:*` script using [the benchmark guide](docs/benchmarking.md).

Maintainers should follow [the release guide](docs/releasing.md) for registry
setup, synchronized versioning, release tags, and trusted publishing. Its full
release gates apply to releases, not every local edit.
