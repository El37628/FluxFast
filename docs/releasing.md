# Releasing FluxFast

Stable releases publish the same version to PyPI, `@fluxfast/core`, and
`@fluxfast/next`. Pushing a matching `vMAJOR.MINOR.PATCH` tag starts
`.github/workflows/release.yml`. The workflow validates versions, runs all
tests, builds and smoke-tests the distributions, publishes through short-lived
OIDC credentials, and creates a GitHub release containing those distributions.
The tagged release workflow calls the same JavaScript, Python, integration,
container, and release-artifact workflows used for pull requests. Artifact
building and publication cannot begin until those reusable workflow gates pass,
so the GitHub release cannot race ahead of production, Docker, or rootless
Podman failures.
Before publication, the built wheel and npm tarballs are installed together in
a clean temporary consumer. That consumer runs `fluxfast init`, validates
generated contracts, runs `fluxfast build`, and launches `fluxfast start` from
the isolated wheel environment. It verifies public health/readiness, one-origin
browser behavior, generated validation and form submission, mutation patches,
deferred/live settlement, dynamic-route navigation and history restoration, and
clean shutdown without importing a source checkout.
The release gate also runs a separate clean consumer against Redis with three
independent FastAPI worker processes. From only the built wheel and npm
tarballs, it proves that a deferred live resource is populated by one worker,
reused from the shared cache by another, invalidated by a mutation on a third,
synchronized over Redis Pub/Sub, and then reused at its new value without
running another loader.
Before publication, the release-artifact workflow creates a real consumer using
published 0.9.0 packages. One run installs the built current Python candidate
first while JavaScript remains at 0.9.0; a second installs the built current
JavaScript candidate first while Python remains at 0.9.0. Both mixed states
must pass the full deferred, live, typed, mutation, navigation, and distributed
Redis browser scenario before the remaining packages are upgraded. The matched
candidate is tested again, then both sides are rolled back to 0.9.0 and must
regenerate, typecheck, production-build, and run without `fluxfast init`
rewriting the initialized scaffold. The branch gate retains one current-Python
and JavaScript 0.8.1 historical smoke; v0.8.1 is no longer the complete matrix.

After registry publication, the release workflow repeats both complete upgrade
and rollback orders using only registry packages. The GitHub release is created
only after these registry-backed compatibility checks pass.

A release that changes typed contracts or code generation must also prove the
developer-tooling path from built artifacts: install the wheel and npm
tarballs into a clean consumer, run `fluxfast types`, run its read-only
`--check`, typecheck and production-build the generated application, and verify
that no source checkout is required. Review generated manifest fingerprints
and TypeScript files as release artifacts of the authoritative Python schema,
not as hand-maintained package source. The mixed-version jobs must continue to
prove that an older JavaScript client can consume the unchanged browser
protocol from a typed Python server and that current JavaScript still supports
an older Python server without a developer manifest.

The normal integration workflow also exercises the real Redis cache, live
broker, restart behavior, and independent Uvicorn workers against the oldest
and newest [supported Redis server lines](distributed-cache.md#supported-redis-versions).
Both matrix ends must be green before preparing a release that changes
distributed-cache behavior.

## v0.9 release integrity policy

FluxFast v0.9 selects the GitHub release, workflow provenance, and digest policy
instead of requiring maintainers to GPG-sign release tags. Release tags remain
annotated, immutable, restricted to maintainers, and must identify a reviewed
commit already reachable from `main`; an unsigned annotated tag is therefore
not itself a release failure. This avoids making a local signing-key setup a
release blocker while retaining an auditable build and publication chain.

Before publication, the release workflow builds exactly four distributions:

```text
fluxfast-VERSION-py3-none-any.whl
fluxfast-VERSION.tar.gz
fluxfast-core-VERSION.tgz
fluxfast-next-VERSION.tgz
```

The release artifact verifier rejects missing or extra distributions, unsafe
archive entries, metadata drift, missing export or command targets, dependency
and peer-dependency drift, incorrect Python metadata, mismatched license or
README content, and packaged source/build output that differs from the checked
out package trees. It then writes `SHA256SUMS` for the four verified files.
The GitHub release attaches those exact distributions and the checksum file;
after downloading the five assets into one directory, verify them with:

```bash
sha256sum --check SHA256SUMS
```

Registry publication uses short-lived GitHub OIDC identities rather than
stored publication tokens. npm publication requests registry provenance for
both packages. PyPI trusted publishing emits PEP 740 attestations explicitly.
All external release actions stay pinned to full commit SHAs, and write
permissions remain scoped to the individual publish or GitHub-release job that
needs them. Post-publication registry-consumer and mixed-version checks must pass
before the GitHub release is created. CodeQL and dependency-security failures
remain release failures; only independently diagnosed registry availability
failures may be retried without weakening vulnerability policy.

## Protected repository governance

During 1.0 preparation, follow the [dependency-freeze policy and reviewed
tooling inventory](releases/v1.0-dependency-freeze.md). Routine major dependency
upgrades are deferred; security and necessary compatibility corrections remain
eligible after validation. A green dependency PR alone is not a reason to
change the stable candidate's test environment.

The active `Protect main` ruleset requires an up-to-date pull request, resolved
review threads, and the following merge checks. The list covers every supported
Python and Node.js runtime, protocol and browser integration, representative
distributed and packed-production behavior, release artifacts, dependency
security, and both CodeQL languages.

<!-- governance-facts:start -->
```json
{
  "mainRuleset": {
    "name": "Protect main",
    "strict": true,
    "pullRequestRequired": true,
    "reviewThreadsResolved": true,
    "requiredChecks": [
      "Node 22",
      "Node 24",
      "Python 3.11",
      "Python 3.12",
      "Python 3.13",
      "Python 3.14",
      "protocol",
      "Redis multi-worker",
      "Same-origin browser flow",
      "Four-distribution contract",
      "Python wheel consumer",
      "Clean production consumer",
      "pnpm audit",
      "pip-audit",
      "Dependency review",
      "Analyze javascript-typescript",
      "Analyze python"
    ]
  },
  "releaseTagRuleset": {
    "name": "Protect release tags",
    "pattern": "refs/tags/v*.*.*",
    "rules": ["creation", "update", "deletion", "non_fast_forward"]
  },
  "nonRequiredExhaustiveChecks": [
    "Generated artifacts (ubuntu-latest)",
    "Generated artifacts (windows-latest)",
    "Redis 6.2.24 on Python 3.11",
    "Redis 8.10.1 on Python 3.14",
    "Distributed browser flow",
    "Clean live consumer",
    "Clean distributed consumer",
    "v0.9.0 adjacent upgrade and rollback compatibility",
    "Docker production image",
    "Rootless Podman production image",
    "Docker Compose with Redis",
    "Rootless Podman Compose with Redis"
  ]
}
```
<!-- governance-facts:end -->

The non-required checks still run in their ordinary workflows and remain part
of release validation. They are not all branch-protection requirements because
duplicating every platform and exhaustive consumer path would over-gate small
pull requests. The controlled benchmark workflow remains manual and is never a
routine merge requirement. Release tags retain the existing annotated-tag,
protected mutation, reviewed-main, workflow-provenance, OIDC, and SHA256SUMS
policy; GPG signing remains optional.

The API payloads for these two repository settings are versioned in
`.github/rulesets/protect-main.json` and
`.github/rulesets/protect-release-tags.json`. GitHub does not apply those
files automatically; a maintainer updates the corresponding active ruleset
through the GitHub API, then compares the returned ruleset with the reviewed
payload.

## One-time registry setup

Create GitHub environments named `pypi` and `npm`. Add required reviewers to
both environments so a tag cannot publish without approval. Protect release
tags matching `v*` in the repository rules as well.

Before the first public release, also configure these repository settings:

- Protect `main`, require pull requests, and require the Python, JavaScript,
  integration, release-artifact, dependency-security, and CodeQL checks.
- Enable private vulnerability reporting, Dependabot alerts, and Dependabot
  security updates under **Settings → Security**.
- Keep the default workflow token read-only. The release workflow grants its
  publish jobs only the narrower write permissions they require.
- Limit creation of tags matching `v*` to maintainers and disallow tag updates
  and deletion.

For PyPI, configure a pending or existing trusted publisher for `fluxfast`:

- Owner: `El37628`
- Repository: `FluxFast`
- Workflow: `release.yml`
- Environment: `pypi`

Follow the [PyPI trusted publisher guide](https://docs.pypi.org/trusted-publishers/).
No PyPI API token is required.

npm requires a package to exist before trusted publishing can be configured.
Confirm that your npm account owns the `@fluxfast` scope, then bootstrap both
package names once from a clean `main` checkout using an interactive account
protected by two-factor authentication. Use a temporary prerelease so the
first stable version remains available for automation:

```bash
pnpm install --frozen-lockfile
pnpm build
npm login

bootstrap_dir="$(mktemp -d)"
cp -R packages/core "$bootstrap_dir/core"
cp -R packages/next "$bootstrap_dir/next"
npm pkg set version=0.0.0-oidc-bootstrap.0 --prefix "$bootstrap_dir/core"
npm pkg set version=0.0.0-oidc-bootstrap.0 --prefix "$bootstrap_dir/next"
npm pkg set 'dependencies.@fluxfast/core=0.0.0-oidc-bootstrap.0' \
  --prefix "$bootstrap_dir/next"
npm publish "$bootstrap_dir/core" --access public --tag bootstrap
npm publish "$bootstrap_dir/next" --access public --tag bootstrap
```

Configure a trusted publisher on each npm package with these exact values:

- Organization or user: `El37628`
- Repository: `FluxFast`
- Workflow filename: `release.yml`
- Environment: `npm`
- Allowed action: `npm publish`

The [npm trusted publishing guide](https://docs.npmjs.com/trusted-publishers/)
contains the corresponding package-settings form. After configuring both
connections, require two-factor authentication and disallow traditional
automation tokens.

## Publish a stable release

Add user-facing changes beneath `Unreleased` in `CHANGELOG.md`, then synchronize
the package manifests, Python runtime version, lockfile, and dated release
section together:

```bash
version=0.9.0
pnpm release:prepare "$version"
pnpm release:check "v$version"
```

Commit and review the generated version changes before tagging. Do not edit or
move a tag after publishing.

After the version change has passed review and reached `main`, release it from
an up-to-date checkout:

```bash
git switch main
git pull --ff-only
version=0.9.0
pnpm release:check "v$version"
git tag -a "v$version" -m "FluxFast $version"
git push origin "v$version"
```

Approve the `pypi` and `npm` deployment jobs in GitHub when prompted. Never
move a published tag or reuse a package version; publish a new patch instead.
If npm publishing is interrupted between its two packages, rerunning the failed
job verifies the already-published tarball's exact integrity before continuing.
After the first stable release succeeds, remove the bootstrap dist-tags:

```bash
npm dist-tag rm @fluxfast/core bootstrap
npm dist-tag rm @fluxfast/next bootstrap
```
