# Operations Board soak consumer

This is a repository-owned release-evidence application, not a distributed SDK
package or production authentication template. Its public seed accounts are
`alice`, `bob` and `carol`, password `soak-password`. Run only on loopback in an
isolated consumer. It deliberately uses a two-second SSE connection age to
exercise normal authorization-rechecking rotations; FluxFast defaults do not
change.

On Linux with supported Python and Node installed, from the repository root:

```bash
node scripts/run-v1-soak.mjs
```

The runner creates a consumer outside the checkout, a separate Python venv,
and independently installed published Python/Core/Next `0.9.0` packages. It
initializes eight components, generates all six contracts, checks them,
typechecks, builds, runs production doctor, and installs matching Chromium.
Then three browser identities exercise 200 complete task workflows per start
across three supervisor starts (600 cycles). Every cycle creates, edits,
discusses, advances and deletes an actual work item, checks a same-tenant
observer's canonical state and a different tenant's isolation, and exercises
navigation/search/history. Additional scenarios cover native/server/nested
validation, profile changes, prefetch, logout/relogin, revoked sessions, and
stored edits/deletions across restarts.

The printed JSON evidence path contains actual versions, elapsed time, workload
counts, stream rotations, RSS samples, generated-input hashes, diagnostics and
shutdown/orphan checks. SQLite databases and reports are retained in the
created temporary directory, including on failure. No password or session
cookie is written to the report. RSS samples alone are not a retained-heap or
multi-day stability claim; review them and the incident log before promotion.

For a shorter diagnostic trial, without claiming the full gate passed:

```bash
node scripts/run-v1-soak.mjs --cycles 2 --starts 2
```

To prepare an isolated app for manual exploration without running automation:

```bash
node scripts/run-v1-soak.mjs --prepare-only
```

Use the exact consumer path printed above, not a source fixture or linked SDK:

```bash
cd /tmp/fluxfast-v1-soak-PRINTED_ID/board
../venv/bin/fluxfast start backend:app --frontend . --host 127.0.0.1
```

Open the printed public URL. Start Alice and Bob in separate browser profiles,
edit work items and verify both update, then open Carol's Beta workspace and
verify it never receives Alpha data. Stop with Ctrl+C and restart to verify
persistence. Stop manual exploration before reusing that consumer in automation:

```bash
node scripts/exercise-v1-soak.mjs /tmp/fluxfast-v1-soak-PRINTED_ID/board --cycles 2 --starts 2
```

Each automated invocation uses a fresh database, preserved across that run's
supervisor starts, so an earlier diagnostic cannot contaminate later counts.
The source fixture contains no manually maintained generated files; always use
`fluxfast types`/generation. Release conclusions belong in
[the incident/evidence record](../../docs/releases/v1.0-soak.md), not here.
