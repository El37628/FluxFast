# Upgrade from v0.9 to v1.0

No application rewrite is required. FluxFast 1.0 promotes the public Python,
Core, Next.js, CLI, generated-code, `fluxfast/1` protocol, and
`fluxfast-schema/2` contracts frozen in v0.9.0.

## 1. Upgrade the synchronized packages

Upgrade all three distributions together:

```bash
python -m pip install --upgrade "fluxfast==1.0.0"
npm install @fluxfast/core@1.0.0 @fluxfast/next@1.0.0
```

FluxFast detects npm, pnpm, Yarn, or Bun for its own frontend commands. The npm
command above is an example, not a package-manager requirement.

## 2. Regenerate and review generated artifacts

Run the authoritative full-stack generator:

```bash
fluxfast types backend.main:app --frontend frontend
```

Review the semantic diff in the frontend's `.fluxfast` directory. Generated
source formatting may change, but public names, accepted inputs, return types,
and module relationships remain compatible. Then verify there is no drift:

```bash
fluxfast types backend.main:app --frontend frontend --check
```

Do not run `fluxfast init` for an existing v0.9 application. An initialized
application already has the required Next.js shell, registry, and configuration;
the initializer is not part of a routine upgrade.

## 3. Typecheck and build

Run the application's normal frontend typecheck, then build through FluxFast so
the backend schema and generated files are validated together:

```bash
npm --prefix frontend run typecheck
fluxfast build --app backend.main:app --frontend frontend
```

## 4. Run the production doctor

```bash
fluxfast doctor --production \
  --app backend.main:app \
  --frontend frontend \
  --strict
```

Resolve every strict diagnostic before deployment. Deploy the same synchronized
package versions that were generated, typechecked, built, and checked.

## 5. Rollback if needed

Rollback remains compatible: reinstall the three v0.9.0 packages, regenerate
artifacts, typecheck, and rebuild. Do not rerun `fluxfast init`; the v1.0
release gates verify upgrade and rollback in the same initialized application.

Package, browser-protocol, and developer-schema versions are independent.
FluxFast 1.0 continues using `fluxfast/1` and `fluxfast-schema/2`; this is
expected and does not indicate an incomplete upgrade.
