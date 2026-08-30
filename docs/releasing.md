# Releasing FluxFast

Stable releases publish the same version to PyPI, `@fluxfast/core`, and
`@fluxfast/next`. Pushing a matching `vMAJOR.MINOR.PATCH` tag starts
`.github/workflows/release.yml`. The workflow validates versions, runs all
tests, builds and smoke-tests the distributions, publishes through short-lived
OIDC credentials, and creates a GitHub release containing those distributions.
Before publication, the built wheel and npm tarballs are installed together in
a clean temporary consumer. That consumer runs `fluxfast init`, builds a
production Next application, launches its own FastAPI backend from the isolated
wheel environment, and proves deferred skeleton-to-resource behavior in a real
browser through one origin.

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
pnpm release:prepare 0.2.0
pnpm release:check v0.2.0
```

Commit and review the generated version changes before tagging. Do not edit or
move a tag after publishing.

After the version change has passed review and reached `main`, release it from
an up-to-date checkout. For version `0.2.0`:

```bash
git switch main
git pull --ff-only
pnpm release:check v0.2.0
git tag -a v0.2.0 -m "FluxFast 0.2.0"
git push origin v0.2.0
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
