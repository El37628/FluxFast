# Releasing FluxFast

## Historical release snapshots

Final runtime snapshots are immutable evidence for the release they audited.
After that release is published, repository tests validate the recorded fixture
and its audit facts rather than comparing all future development to the old
runtime digest. A later release candidate that changes runtime source requires
its own review and evidence before tagging; never rewrite an earlier release's
snapshot to make a new change pass.

Stable releases publish the same version to Python and the npm packages in
that release line. From 1.2, this means `fluxfast`, `@fluxfast/core`,
`@fluxfast/codegen`, `@fluxfast/react`, `@fluxfast/vite`, `@fluxfast/next`,
and `@fluxfast/devtools`. Pushing a matching `vMAJOR.MINOR.PATCH` tag starts
`.github/workflows/release.yml`. The workflow validates versions, runs all
tests, builds and smoke-tests the distributions, publishes through short-lived
OIDC credentials, and creates a GitHub release containing those distributions.
The tagged release workflow calls the same JavaScript, Python, integration,
container, and release-artifact workflows used for pull requests. Artifact
building and publication cannot begin until those reusable workflow gates pass,
so the GitHub release cannot race ahead of production, Docker, or rootless
Podman failures.
Before publication, one job builds and verifies the wheel, source distribution,
and every required npm tarball, then uploads that exact checksum-bound candidate for the
consumer jobs. The source distribution is installed in a dedicated clean
virtual environment; the wheel and npm tarballs are installed together in a
separate clean application consumer. That consumer runs `fluxfast init`, validates
generated contracts, runs `fluxfast build`, and launches `fluxfast start` from
the isolated wheel environment. It verifies public health/readiness, one-origin
browser behavior, generated validation and form submission, mutation patches,
deferred/live settlement, dynamic-route navigation and history restoration, and
clean shutdown without importing a source checkout.
The complete acceptance mapping is recorded in the
[v1.0 packed-candidate gate](releases/v1.0-packed-candidate.md).
The subsequent [v1.0 final freeze audit](releases/v1.0-final-freeze-audit.md)
locks the normalized candidate runtime before the version-only promotion.
The release gate also runs a separate clean consumer against Redis with three
independent FastAPI worker processes. From only the built wheel and npm
tarballs, it proves that a deferred live resource is populated by one worker,
reused from the shared cache by another, invalidated by a mutation on a third,
synchronized over Redis Pub/Sub, and then reused at its new value without
running another loader. Its frontend uses the optimized production build, and
the gate verifies graceful shutdown of the frontend, proxy, and all workers.
Before publication, the release-artifact workflow creates real consumers using
published 1.0.1 and 1.1.0 packages. For each baseline, one run installs the built
current Python candidate first while JavaScript remains at that baseline; a
second installs the built current JavaScript candidate first while Python stays
at the baseline. Both mixed states
must pass the full deferred, live, typed, mutation, navigation, and distributed
Redis browser scenario before the remaining packages are upgraded. The matched
candidate is tested again, then both sides are rolled back to the baseline and must
regenerate, typecheck, production-build, and run without `fluxfast init`
rewriting the initialized scaffold. The branch gate retains one current-Python
and JavaScript 0.8.1 historical smoke; v0.8.1 is no longer the complete matrix.

After registry publication, the release workflow repeats both complete upgrade
and rollback orders against both baselines using only registry packages. The
GitHub release is created only after these registry-backed compatibility checks
and the matched Next and React production consumers pass.

Before the published DevTools/Next consumer installs its packages, it waits for
all six npm distributions in both the full package index and npm's abbreviated
install metadata. A version endpoint or DevTools becoming available does not
prove that the other packages have propagated. Only HTTP 404 or a missing
target version receives bounded retries; authentication, network, other HTTP,
and malformed-metadata errors fail immediately. Installation prefers fresh
registry metadata, and the existing version and production checks still run.

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

The tooling compatibility gate checks all six generated artifacts. Each schema
and typed header must name the Python distribution actually installed in that
consumer. A package-version promotion changes that producer metadata, not the
contract: comparison normalizes only the validated top-level producer field
and the four generated producer comments. Fingerprints, protocol/schema IDs,
types, validators, routes, mutations, registries and all other bytes must match.
Read-only checks still preserve the original files, bytes and modification times.

The normal integration workflow also exercises the real Redis cache, live
broker, restart behavior, and independent Uvicorn workers against the oldest
and newest [supported Redis server lines](distributed-cache.md#supported-redis-versions).
Both matrix ends must be green before preparing a release that changes
distributed-cache behavior.

## Stable release integrity policy

FluxFast stable releases use the GitHub release, workflow provenance, and
digest policy instead of requiring maintainers to GPG-sign release tags.
Release tags remain
annotated, immutable, restricted to maintainers, and must identify a reviewed
commit already reachable from `main`; an unsigned annotated tag is therefore
not itself a release failure. This avoids making a local signing-key setup a
release blocker while retaining an auditable build and publication chain.

Before publication, the release workflow builds the exact distribution set for
the target version. FluxFast 1.0.x retains its immutable four-distribution
contract. FluxFast 1.1 adds the optional DevTools package, for five distributions;
1.2 adds Codegen, React and Vite, for eight:

```text
fluxfast-VERSION-py3-none-any.whl
fluxfast-VERSION.tar.gz
fluxfast-core-VERSION.tgz
fluxfast-next-VERSION.tgz
fluxfast-devtools-VERSION.tgz
fluxfast-codegen-VERSION.tgz
fluxfast-react-VERSION.tgz
fluxfast-vite-VERSION.tgz
```

The release artifact verifier rejects missing or extra distributions, unsafe
archive entries, metadata drift, missing export or command targets, dependency
and peer-dependency drift, incorrect Python metadata, mismatched license or
README content, and packaged source/build output that differs from the checked
out package trees byte for byte. It then writes `SHA256SUMS` for every verified
file. The verifier remains version-aware so rerunning the 1.0.x evidence still
expects four distributions while 1.1 requires DevTools and 1.2 requires all eight.
Before either
registry job starts, a separate job downloads all three immutable workflow
artifacts, rebuilds the JavaScript package output from the tagged source, and
repeats the full content and checksum verification. The
final GitHub-release job rebuilds, downloads, and verifies the payload again
before attaching the complete version-specific distribution set and checksum file. The historical 1.0
proof is recorded in the
[v1.0 artifact-verification gate](releases/v1.0-artifact-verification.md).
The protected check context retains the historical name
`Four-distribution contract` for branch-rule continuity, but its current run uses
the version-aware distribution verifier described above.

The v1.2 candidate additionally requires Codegen, React and Vite
tarballs. The verifier
checks eight distributions against source intent, including dependency/optional
peer metadata and all packed output. Historical v1.0/v1.1 payloads are unchanged.
The candidate-artifact job runs the same React browser contracts against these
exact verified archives, not separately rebuilt copies. The tag workflow also
tests its final publication payload in both modes before uploading it to the
registry jobs. React cold hydration, navigation, same-origin source/HMR updates,
initialization, Python supervision, and immutable production execution without
source, Next, Vite, Codegen or TypeScript must all pass.

After publication, a separate consumer installs the matching Python distribution
and Core, Codegen, React, Vite and DevTools from the registries only, verifies their
installed versions, and repeats the development and production contracts. It
cannot fall back to checkout builds or local archives. Only a missing registry
version (HTTP 404) receives bounded propagation retries; authentication, network,
malformed-data and other HTTP failures fail closed. The GitHub release waits for
this job as well as the Next and upgrade/rollback consumers.

Do not publish the foundation alone: complete React SSR/Vite host conformance
must pass before v1.2.0. New npm package names also need their own trusted-publisher setup
before the tag workflow can publish them; existing publishers do not grant
publication rights to newly introduced packages automatically.
After downloading the release assets into one directory, verify them
with:

```bash
sha256sum --check SHA256SUMS
```

Registry publication uses short-lived GitHub OIDC identities rather than
stored publication tokens. npm publication requests registry provenance for
all six npm packages. PyPI trusted publishing emits PEP 740 attestations
explicitly.
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
change the stable release line's test environment.

The [v1.0 supply-chain gate](releases/v1.0-supply-chain-gate.md) audits the
workspace lock and Python base, Redis, and dev dependency groups in both PR and
tag-release workflows. Audit-service errors fail the gate; they are never
treated as evidence of a clean dependency set. Every external workflow action
must retain a full commit-SHA pin.

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
    "Fresh documentation consumer",
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

Create GitHub environments named `pypi` and `npm`. Configure appropriate required
reviewers if your repository/account supports that protection; approval controls
are shown only when a job actually has a configured approval gate. Protect release
tags matching `v*` in the repository rules as well.

Before the first public release of any package, also configure these repository
settings:

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
Confirm that your npm account owns the `@fluxfast` scope, then bootstrap only
missing package names once from a clean, reviewed `main` checkout using an interactive account
protected by two-factor authentication. Use a temporary prerelease so the
first stable version remains available for automation:

```bash
pnpm install --frozen-lockfile
pnpm build
npm login --auth-type=web

bootstrap_dir="$(mktemp -d)"
for package in codegen react vite; do
  # Only use this list when these names do not yet exist in the registry.
  mkdir "$bootstrap_dir/$package"
  cp packages/"$package"/package.json packages/"$package"/README.md \
    packages/"$package"/LICENSE "$bootstrap_dir/$package/"
  cp -R packages/"$package"/dist "$bootstrap_dir/$package/dist"
  if [ -d packages/"$package"/bin ]; then
    cp -R packages/"$package"/bin "$bootstrap_dir/$package/bin"
  fi
  npm pkg set version=0.0.0-oidc-bootstrap.0 --prefix "$bootstrap_dir/$package"
  npm publish "$bootstrap_dir/$package" --access public --tag bootstrap
done
```

For 1.2, existing Core, Next and DevTools publishers remain configured; the new
names are Codegen, React and Vite. Check registry existence before running a
bootstrap. A bootstrap is setup-only, may reference the upcoming synchronized
dependencies, and is not an application installation or a stable release.
Never republish or reuse an existing package version.

Configure a trusted publisher on each npm package with these exact values:

- Organization or user: `El37628`
- Repository: `FluxFast`
- Workflow filename: `release.yml`
- Environment: `npm`
- Allowed action: `npm publish`

The [npm trusted publishing guide](https://docs.npmjs.com/trusted-publishers/)
contains the corresponding package-settings form. Alternatively, npm 11.15+
provides the [interactive trust command](https://docs.npmjs.com/cli/v11/commands/npm-trust/):

```bash
npm trust github @fluxfast/codegen --repository El37628/FluxFast \
  --file release.yml --environment npm --allow-publish
npm trust github @fluxfast/react --repository El37628/FluxFast \
  --file release.yml --environment npm --allow-publish
npm trust github @fluxfast/vite --repository El37628/FluxFast \
  --file release.yml --environment npm --allow-publish
```

This is a credential configuration step: the package must already exist, the
account must have write permission, and the command requires interactive
authentication/2FA. Do not send passwords, tokens or OTPs to an agent or commit
them. Verify every required package's connection **before pushing the stable tag**.
After configuring all six connections, require two-factor authentication and disallow traditional
automation tokens.

## Publish a stable release

Add user-facing changes beneath `Unreleased` in `CHANGELOG.md`, then synchronize
the package manifests, Python runtime version, lockfile, and dated release
section together:

```bash
version=1.2.0
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
version=1.2.0
pnpm release:check "v$version"
git tag -a "v$version" -m "FluxFast $version"
git push origin "v$version"
```

Approve the `pypi` and `npm` deployment jobs in GitHub when prompted. Never
move a published tag or reuse a package version; publish a new patch instead.
If npm publishing is interrupted between its packages, rerunning the
failed job verifies the already-published tarball's exact integrity before
continuing.
After the first stable release succeeds, remove the bootstrap dist-tags:

```bash
npm dist-tag rm @fluxfast/core bootstrap
npm dist-tag rm @fluxfast/next bootstrap
npm dist-tag rm @fluxfast/devtools bootstrap
npm dist-tag rm @fluxfast/codegen bootstrap
npm dist-tag rm @fluxfast/react bootstrap
npm dist-tag rm @fluxfast/vite bootstrap
```
