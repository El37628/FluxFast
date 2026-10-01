import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createPublicApiSnapshot } from "./public-api-snapshot.mjs";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const expected = {
  typeOnly: ["FluxFastGenerationCheckResult", "FluxFastGenerationOptions", "FluxFastGenerationResult",
    "FluxFastSchemaManifest", "FluxPageRegistryTarget", "JsonSchema", "PagesRegistryOptions", "PagesRegistrySnapshot", "ValidatorCompilationDiagnostic",
    "ValidatorCompilationOptions", "ValidatorCompilationResult"],
  valueOnly: ["checkFluxFastProject", "compileFluxFastMutations", "compileFluxFastPageRoutes",
    "compileFluxFastResourceTypes", "compileFluxFastValidators", "compileFluxFastValidatorsWithDiagnostics",
    "compileJsonSchemaToValidationPlan", "createPagesRegistrySnapshot", "findFluxFastContractsWithUnknownTypes",
    "findFluxFastResourceKeysWithUnknownTypes", "findFluxFastSchemaModeConflicts",
    "generateFluxFastProject", "generatePagesRegistry", "parseFluxFastSchemaManifest", "validateFluxFastSchemaManifest"],
  typeAndValue: ["SchemaCompilationError", "SchemaManifestValidationError", "ValidatorCompilationError"],
};

function run(binary, args, cwd) {
  const result = spawnSync(binary, args, {
    cwd, encoding: "utf8", timeout: 60_000,
    shell: process.platform === "win32" && binary === "npm",
    env: { ...process.env, npm_config_update_notifier: "false" },
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${binary} failed:\n${result.stdout}${result.stderr}`);
  return result.stdout;
}

test("Codegen has one explicit documented Advanced Stable surface, with an example for every export", () => {
  const snapshot = createPublicApiSnapshot().packages["@fluxfast/codegen"];
  assert.deepEqual(snapshot.entries, { ".": expected });
  assert.deepEqual(snapshot.exportMap, {
    ".": { types: "./dist/index.d.ts", import: "./dist/esm/index.js", require: "./dist/index.js", default: "./dist/index.js" },
  });
  const manifest = JSON.parse(fs.readFileSync(path.join(repository, "packages/codegen/package.json"), "utf8"));
  assert.equal(manifest.bin, undefined, "a generic CLI is not part of compiler extraction");
  assert.deepEqual(manifest.dependencies, { "@fluxfast/core": `^${manifest.version}` });
  assert.equal(manifest.peerDependencies, undefined);
  const guide = fs.readFileSync(path.join(repository, "docs/codegen-api.md"), "utf8");
  assert.match(guide, /unreleased v1\.2/);
  assert.match(guide, /Advanced Stable upon v1\.2 publication/);
  const block = guide.split("<!-- codegen-api-examples:start -->")[1]?.split("<!-- codegen-api-examples:end -->")[0];
  assert.ok(block);
  const rows = [...block.matchAll(/^\| `([^`]+)` \| `([^`]+)` \| ([^\n]+) \|$/gm)];
  assert.deepEqual(rows.map(row => row[1]).sort(), Object.values(expected).flat().sort());
  assert.ok(rows.every(row => row[2].trim() && row[3].trim()));
});

test("isolated Codegen tarball supports ESM, CommonJS, types and six frozen bytes without executing Core or installing a framework", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "fluxfast-codegen-package-"));
  try {
    const consumer = path.join(temporary, "consumer");
    fs.mkdirSync(consumer);
    fs.writeFileSync(path.join(consumer, "package.json"), JSON.stringify({ private: true }));
    const archives = [];
    for (const owner of ["core", "codegen"]) {
      const [pack] = JSON.parse(run("npm", ["pack", "--ignore-scripts", "--offline", "--json", "--pack-destination", temporary], path.join(repository, "packages", owner)));
      archives.push(path.join(temporary, pack.filename));
      if (owner === "codegen") {
        for (const target of ["README.md", "LICENSE", "dist/index.d.ts", "dist/index.js", "dist/esm/index.js", "dist/esm/package.json"]) {
          assert.ok(pack.files.some(file => file.path === target), `missing ${target}`);
        }
      }
    }
    run("npm", ["install", ...archives, "--ignore-scripts", "--offline", "--no-audit", "--no-fund", "--no-package-lock", "--loglevel=error"], consumer);
    for (const name of ["react", "react-dom", "next", "@fluxfast/next", "@fluxfast/devtools"]) {
      assert.equal(fs.existsSync(path.join(consumer, "node_modules", name)), false, `${name} must not be installed`);
    }
    // Tripwires in the owned temporary install prove that neither module format
    // executes Core. Its declarations remain intact for the type consumer below.
    for (const entry of ["dist/index.js", "dist/esm/index.js"]) {
      fs.writeFileSync(path.join(consumer, "node_modules/@fluxfast/core", entry), 'throw new Error("Codegen executed Core runtime");\n');
    }
    const fixture = path.join(repository, "tests/fixtures/adapter-baseline-v1.1.0");
    const probe = `
      import assert from "node:assert/strict";
      import fs from "node:fs";
      import path from "node:path";
      import { createHash } from "node:crypto";
      import { createRequire } from "node:module";
      import * as esm from "@fluxfast/codegen";
      const require = createRequire(import.meta.url);
      const cjs = require("@fluxfast/codegen");
      const expected = ${JSON.stringify([...expected.valueOnly, ...expected.typeAndValue].sort())};
      const fixture = ${JSON.stringify(fixture)};
      const baseline = JSON.parse(fs.readFileSync(path.join(fixture, "baseline.json"), "utf8"));
      assert.equal(baseline.capturedFrom, "@fluxfast/next@1.1.0");
      for (const [name, api] of [["esm", esm], ["cjs", cjs]]) {
        assert.deepEqual(Object.keys(api).sort(), expected);
        assert.deepEqual(api.compileJsonSchemaToValidationPlan({type:"string", minLength:2}), {root:{kind:"string", minLength:2}});
        const generatedDir = path.resolve(name, "src/.fluxfast");
        const pagesDir = path.resolve(name, "src/flux-pages");
        for (const [file, content] of Object.entries(baseline.pages)) {
          const source = path.join(pagesDir, file);
          fs.mkdirSync(path.dirname(source), {recursive:true});
          fs.writeFileSync(source, content);
        }
        const registry = api.createPagesRegistrySnapshot({
          pagesDir, outputFile:path.join(generatedDir, "pages.generated.ts"),
          target:{runtimeImport:"@fluxfast/next",rootExport:"FluxRoot",applicationPropsExport:"FluxApplicationProps",clientDirective:true},
        });
        assert.deepEqual(registry.identifiers, ["(admin)/[room-id]", "home/index", "hotel_rooms/index", "legacy"]);
        assert.equal(registry.content, fs.readFileSync(path.join(fixture, "pages.generated.ts"), "utf8"));
        assert.equal(fs.existsSync(generatedDir), false);
        const custom = api.createPagesRegistrySnapshot({pagesDir, outputFile:path.resolve(name, "src/.host-registry/pages.generated.ts"),
          target:{runtimeImport:"@acme/host-runtime", rootExport:"ApplicationRoot",applicationPropsExport:"ApplicationInput"},
        });
        assert.ok(custom.content.includes('import { ApplicationRoot as FluxRoot } from "@acme/host-runtime";'));
        assert.ok(!custom.content.includes("@fluxfast/next"));
        assert.ok(!custom.content.includes('"use client";'));
        const options = {
          log:false, generatedDir, registry,
          schemaContent: fs.readFileSync(path.join(fixture, "schema.generated.json"), "utf8"),
        };
        assert.equal(api.checkFluxFastProject(options).current, false);
        assert.equal(fs.existsSync(generatedDir), false);
        api.generateFluxFastProject(options);
        for (const [artifact, hash] of Object.entries(baseline.artifactDigests)) {
          assert.equal(createHash("sha256").update(fs.readFileSync(path.join(generatedDir, artifact))).digest("hex"), hash, name+" "+artifact);
        }
        assert.equal(api.checkFluxFastProject(options).current, true);
        api.generatePagesRegistry(custom, {log:false});
        fs.writeFileSync(options.registry.outputFile, "stale registry");
        assert.deepEqual(api.checkFluxFastProject(options).staleFiles, [options.registry.outputFile]);
        assert.equal(fs.readFileSync(options.registry.outputFile, "utf8"), "stale registry");
      }
      for (const specifier of ["@fluxfast/codegen/schema-compiler", "@fluxfast/codegen/pages-registry", "@fluxfast/codegen/dist/index.js"]) {
        assert.throws(() => require(specifier), {code:"ERR_PACKAGE_PATH_NOT_EXPORTED"});
        await assert.rejects(import(specifier), {code:"ERR_PACKAGE_PATH_NOT_EXPORTED"});
      }
    `;
    fs.writeFileSync(path.join(consumer, "probe.mjs"), probe);
    run(process.execPath, ["probe.mjs"], consumer);
    const types = `
      import { compileJsonSchemaToValidationPlan, compileFluxFastValidatorsWithDiagnostics,
        generateFluxFastProject, checkFluxFastProject, validateFluxFastSchemaManifest, createPagesRegistrySnapshot,
        type FluxFastGenerationOptions, type FluxFastGenerationResult, type FluxFastGenerationCheckResult,
        type FluxFastSchemaManifest, type JsonSchema, type PagesRegistrySnapshot, type PagesRegistryOptions, type FluxPageRegistryTarget,
        type ValidatorCompilationOptions, type ValidatorCompilationResult, type ValidatorCompilationDiagnostic } from "@fluxfast/codegen";
      const schema: JsonSchema = {type:"string"};
      const plan = compileJsonSchemaToValidationPlan(schema);
      const manifest: FluxFastSchemaManifest = validateFluxFastSchemaManifest({});
      const validation: ValidatorCompilationResult = compileFluxFastValidatorsWithDiagnostics(manifest);
      const diagnostic: ValidatorCompilationDiagnostic | undefined = validation.diagnostics[0];
      const policy: ValidatorCompilationOptions = {unsupported:"report"};
      const registry: PagesRegistrySnapshot = {content:"",files:[],identifiers:[],pagesDir:"src/pages",outputFile:"src/.fluxfast/pages.generated.ts"};
      const target: FluxPageRegistryTarget = {runtimeImport:"@acme/host-runtime",rootExport:"ApplicationRoot",applicationPropsExport:"ApplicationInput",clientDirective:true};
      const registryOptions: PagesRegistryOptions = {target, pagesDir:"src/pages", outputFile:registry.outputFile};
      const scanned: PagesRegistrySnapshot = createPagesRegistrySnapshot(registryOptions);
      // @ts-expect-error Shared scanning requires an explicit adapter target.
      const missingTarget: PagesRegistryOptions = {pagesDir:"src/pages"};
      // @ts-expect-error The client directive policy must be boolean.
      const invalidTarget: FluxPageRegistryTarget = {...target, clientDirective:"yes"};
      const options: FluxFastGenerationOptions = {registry, generatedDir:"src/.fluxfast", log:false};
      const written: FluxFastGenerationResult = generateFluxFastProject(options);
      const checked: FluxFastGenerationCheckResult = checkFluxFastProject(options);
      // @ts-expect-error A framework-neutral project requires an adapter registry.
      const missingRegistry: FluxFastGenerationOptions = {log:false};
      // @ts-expect-error Unsupported contracts can only error or report.
      const unsafe: ValidatorCompilationOptions = {unsupported:"ignore"};
    `;
    for (const extension of ["cts", "mts"]) fs.writeFileSync(path.join(consumer, "consumer." + extension), types);
    run(process.execPath, [path.join(path.dirname(require.resolve("typescript/package.json")), "bin/tsc"),
      "--noEmit", "--strict", "--skipLibCheck", "--module", "NodeNext", "--moduleResolution", "NodeNext",
      "--target", "ES2022", "--lib", "ES2022,DOM,DOM.Iterable", "consumer.cts", "consumer.mts"], consumer);
    fs.writeFileSync(path.join(consumer, "host-types.d.ts"), `
      declare module "react" {
        const React: {createElement<P>(root:(props:P)=>unknown, props:P):unknown};
        export default React;
      }
      declare module "@acme/host-runtime" {
        export type ComponentRegistry = Record<string, {load:()=>Promise<unknown>}>;
        export interface ApplicationInput {initialEnvelope:{page:{component:string}};registry?:ComponentRegistry}
        export function ApplicationRoot(props:ApplicationInput):unknown;
      }
    `);
    run(process.execPath, [path.join(path.dirname(require.resolve("typescript/package.json")), "bin/tsc"),
      "--noEmit", "--strict", "--skipLibCheck", "--module", "ESNext", "--moduleResolution", "Bundler",
      "--target", "ES2022", "--jsx", "preserve", "--allowJs", "host-types.d.ts",
      "esm/src/.host-registry/pages.generated.ts", "cjs/src/.host-registry/pages.generated.ts"], consumer);
  } finally {
    fs.rmSync(temporary, {recursive:true, force:true});
  }
});
