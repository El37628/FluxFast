import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { resolvePublishedProductionConfig } from "./published-production-config.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureRoot = path.join(repositoryRoot, "tests", "release-consumer", "next-init");
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fluxfast-next-init-"));
const consumerRoot = path.join(temporaryRoot, "consumer");
const relativeConsumerRoot = path.relative(repositoryRoot, consumerRoot);
if (
  relativeConsumerRoot === "" ||
  (!path.isAbsolute(relativeConsumerRoot) &&
    !relativeConsumerRoot.startsWith(`..${path.sep}`) &&
    relativeConsumerRoot !== "..")
) {
  throw new Error("The clean consumer must be created outside the repository.");
}
const configuredArtifactRoot = process.env.FLUXFAST_ARTIFACT_DIR;
const artifactRoot = configuredArtifactRoot
  ? path.resolve(configuredArtifactRoot)
  : path.join(temporaryRoot, "artifacts");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const npxCommand = process.platform === "win32" ? "npx.cmd" : "npx";
const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const localPython = path.join(repositoryRoot, ".venv", "bin", "python");
const pythonCommand = process.env.FLUXFAST_E2E_PYTHON ?? (
  fs.existsSync(localPython) ? localPython : "python"
);
const runLiveConsumer = process.env.FLUXFAST_RUN_LIVE === "1";
const runDistributedConsumer = process.env.FLUXFAST_RUN_DISTRIBUTED === "1";
const runProductionConsumer = process.env.FLUXFAST_RUN_PRODUCTION === "1";
const publishedConfig = resolvePublishedProductionConfig({
  version: process.env.FLUXFAST_PUBLISHED_VERSION,
  pythonSpec: process.env.FLUXFAST_PYTHON_SPEC,
  coreSpec: process.env.FLUXFAST_CORE_SPEC,
  nextSpec: process.env.FLUXFAST_NEXT_SPEC,
});
if (
  [runLiveConsumer, runDistributedConsumer, runProductionConsumer]
    .filter(Boolean).length > 1
) {
  throw new Error(
    "Run the clean live, distributed, and production consumers separately."
  );
}
if (publishedConfig && !runProductionConsumer) {
  throw new Error(
    "FLUXFAST_PUBLISHED_VERSION is supported only by the production consumer."
  );
}
if (publishedConfig && configuredArtifactRoot) {
  throw new Error(
    "FLUXFAST_PUBLISHED_VERSION and FLUXFAST_ARTIFACT_DIR are mutually exclusive."
  );
}

function execute(command, args, cwd = repositoryRoot, extraEnvironment = {}) {
  const childEnvironment = { ...process.env };
  for (const key of Object.keys(childEnvironment)) {
    const normalized = key.toLowerCase();
    if (
      normalized.includes("verify_deps_before_run") ||
      normalized.includes("link_workspace_packages") ||
      normalized.includes("@jsr:registry")
    ) {
      delete childEnvironment[key];
    }
  }
  const result = spawnSync(command, args, {
    cwd,
    env: {
      ...childEnvironment,
      NEXT_TELEMETRY_DISABLED: "1",
      ...extraEnvironment,
    },
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  return result.status;
}

function run(command, args, cwd = repositoryRoot, extraEnvironment = {}) {
  const status = execute(command, args, cwd, extraEnvironment);
  if (status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited with status ${status}`);
  }
}

function runExpectingFailure(
  command,
  args,
  cwd = repositoryRoot,
  extraEnvironment = {}
) {
  const status = execute(command, args, cwd, extraEnvironment);
  if (status === 0) {
    throw new Error(`${command} ${args.join(" ")} unexpectedly succeeded`);
  }
  if (status === null) {
    throw new Error(`${command} ${args.join(" ")} exited without a status`);
  }
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function installWithRetry(
  command,
  args,
  label,
  cwd,
  retryRegistryPropagation,
  extraEnvironment = {}
) {
  const attempts = retryRegistryPropagation ? 18 : 1;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const status = execute(command, args, cwd, extraEnvironment);
    if (status === 0) return;
    if (attempt === attempts) {
      throw new Error(`${label} was unavailable after ${attempts} attempt(s).`);
    }
    console.log(
      `Waiting for ${label} registry propagation (${attempt}/${attempts})…`
    );
    await delay(10_000);
  }
}

function findPythonArtifact() {
  const matches = fs
    .readdirSync(artifactRoot)
    .filter(file => file.startsWith("fluxfast-") && file.endsWith(".whl"));
  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one fluxfast-*.whl artifact in ${artifactRoot}; found ${matches.length}.`
    );
  }
  return path.join(artifactRoot, matches[0]);
}

async function prepareIsolatedPython({ distributed = false } = {}) {
  fs.mkdirSync(artifactRoot, { recursive: true });
  const environmentRoot = path.join(temporaryRoot, "python-environment");
  run(pythonCommand, ["-m", "venv", environmentRoot]);
  const isolatedPython = process.platform === "win32"
    ? path.join(environmentRoot, "Scripts", "python.exe")
    : path.join(environmentRoot, "bin", "python");
  run(isolatedPython, ["-m", "ensurepip", "--upgrade"]);

  let requirement;
  if (publishedConfig) {
    requirement = publishedConfig.pythonSpec;
  } else {
    const existingWheels = fs
      .readdirSync(artifactRoot)
      .filter(file => file.startsWith("fluxfast-") && file.endsWith(".whl"));
    if (existingWheels.length === 0) {
      run(isolatedPython, [
        "-m",
        "pip",
        "wheel",
        "--no-deps",
        "--wheel-dir",
        artifactRoot,
        path.join(repositoryRoot, "python", "fluxfast"),
      ]);
    }

    const wheel = findPythonArtifact();
    requirement = distributed
      ? `fluxfast[redis] @ ${pathToFileURL(wheel).href}`
      : wheel;
  }
  const requirements = ["-m", "pip", "install", requirement];
  if (distributed) requirements.push("httpx2>=2.0.0,<3.0.0");
  if (publishedConfig) {
    requirements.splice(3, 0, "--disable-pip-version-check");
    await installWithRetry(
      isolatedPython,
      requirements,
      publishedConfig.pythonSpec,
      consumerRoot,
      publishedConfig.retryPython,
      { PYTHONPATH: "" }
    );
  } else {
    run(isolatedPython, requirements, consumerRoot, { PYTHONPATH: "" });
  }
  const imports = distributed
    ? "import fluxfast, httpx2, redis; modules = (fluxfast, httpx2, redis)"
    : "import fluxfast; modules = (fluxfast,)";
  run(
    isolatedPython,
    [
      "-c",
      "import sys; from importlib.metadata import version as package_version; "
        + "from pathlib import Path; "
        + `${imports}; `
        + "repository = Path(sys.argv[1]).resolve(); "
        + "assert all(not Path(entry).resolve().is_relative_to(repository) "
        + "for entry in sys.path if entry); "
        + "assert all(Path(module.__file__).resolve().is_relative_to(Path(sys.prefix).resolve()) "
        + "for module in modules); "
        + "expected = sys.argv[2]; "
        + "assert not expected or package_version('fluxfast') == expected",
      repositoryRoot,
      publishedConfig?.version ?? "",
    ],
    consumerRoot,
    { PYTHONPATH: "" }
  );
  return isolatedPython;
}

function isolatedFluxfastExecutable(isolatedPython) {
  const environmentBin = path.dirname(isolatedPython);
  return path.join(
    environmentBin,
    process.platform === "win32" ? "fluxfast.exe" : "fluxfast"
  );
}

function findArtifact(packageName) {
  const prefix = `fluxfast-${packageName}-`;
  const matches = fs
    .readdirSync(artifactRoot)
    .filter(file => file.startsWith(prefix) && file.endsWith(".tgz"));
  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one ${prefix}*.tgz artifact in ${artifactRoot}; found ${matches.length}.`
    );
  }
  return path.join(artifactRoot, matches[0]);
}

function assertIsolatedNpmPackage(packageName) {
  const packageRoot = fs.realpathSync(
    path.join(consumerRoot, "node_modules", ...packageName.split("/"))
  );
  if (!packageRoot.startsWith(`${consumerRoot}${path.sep}`)) {
    throw new Error(`${packageName} resolved outside the isolated consumer: ${packageRoot}`);
  }
  return JSON.parse(
    fs.readFileSync(path.join(packageRoot, "package.json"), "utf8")
  ).version;
}

function typedGenerationArgs({ check = false } = {}) {
  const args = [
    "-m",
    "fluxfast.cli",
    "types",
    "backend:app",
    "--frontend",
    consumerRoot,
  ];
  if (check) args.push("--check");
  return args;
}

function assertTypedConsumerArtifacts() {
  const generatedRoot = path.join(consumerRoot, "src", ".fluxfast");
  const expectedFiles = [
    "schema.generated.json",
    "types.generated.ts",
    "validators.generated.ts",
    "routes.generated.ts",
    "mutations.generated.ts",
    "pages.generated.ts",
  ];
  for (const file of expectedFiles) {
    assert.equal(
      fs.existsSync(path.join(generatedRoot, file)),
      true,
      `${file} must be generated inside the isolated consumer`
    );
  }

  const schema = JSON.parse(
    fs.readFileSync(path.join(generatedRoot, "schema.generated.json"), "utf8")
  );
  const [producerMajor, producerMinor] = schema.producer
    .split(".", 2)
    .map(part => Number(part));
  const expectedSchema = producerMajor > 0 || producerMinor >= 8
    ? "fluxfast-schema/2"
    : "fluxfast-schema/1";
  assert.equal(schema.schema, expectedSchema);
  if (expectedSchema === "fluxfast-schema/2") {
    assert.deepEqual(schema.types, {});
  } else {
    assert.equal("types" in schema, false);
  }
  assert.deepEqual(Object.keys(schema.resources).sort(), [
    "analytics",
    "live-counter",
    "live-report",
  ]);
  assert.equal(
    schema.pages.some(page => page.name === "home" && page.path === "/"),
    true
  );
  assert.equal(
    schema.mutations.some(
      mutation =>
        mutation.name === "increment" &&
        mutation.path === "/increment" &&
        mutation.method === "POST"
    ),
    true
  );

  const types = fs.readFileSync(
    path.join(generatedRoot, "types.generated.ts"),
    "utf8"
  );
  assert.match(types, /interface Analytics/);
  assert.match(types, /liveCounter: "live-counter"/);
  assert.match(types, /interface FluxResourceMap/);
  assert.match(types, /interface IncrementBody/);
  assert.match(types, /amount: number/);

  const mutations = fs.readFileSync(
    path.join(generatedRoot, "mutations.generated.ts"),
    "utf8"
  );
  assert.match(mutations, /increment:/);
  assert.match(mutations, /body: IncrementBody/);

  const page = fs.readFileSync(
    path.join(consumerRoot, "src", "flux-pages", "home", "index.tsx"),
    "utf8"
  );
  assert.doesNotMatch(page, /use(?:Deferred)?Resource\s*</);
  assert.match(page, /resourceKeys\.analytics/);
  assert.match(page, /mutations\.increment/);
}

function verifyTypedSchemaDrift(isolatedPython) {
  const backendPath = path.join(consumerRoot, "backend.py");
  const schemaPath = path.join(
    consumerRoot,
    "src",
    ".fluxfast",
    "schema.generated.json"
  );
  const original = fs.readFileSync(backendPath, "utf8");
  const originalFingerprint = JSON.parse(
    fs.readFileSync(schemaPath, "utf8")
  ).fingerprint;
  const marker = "    load: int\n";
  assert.equal(original.includes(marker), true);
  const changed = original.replace(
    marker,
    `${marker}    currency: str = "USD"\n`
  );
  const environment = { PYTHONPATH: "" };

  try {
    fs.writeFileSync(backendPath, changed, "utf8");
    runExpectingFailure(
      isolatedPython,
      typedGenerationArgs({ check: true }),
      consumerRoot,
      environment
    );
    assert.equal(
      JSON.parse(fs.readFileSync(schemaPath, "utf8")).fingerprint,
      originalFingerprint,
      "the read-only drift check must not rewrite the generated manifest"
    );
    run(
      isolatedPython,
      typedGenerationArgs(),
      consumerRoot,
      environment
    );
    assert.notEqual(
      JSON.parse(fs.readFileSync(schemaPath, "utf8")).fingerprint,
      originalFingerprint,
      "regeneration must record the changed Python contract"
    );
    run(
      isolatedPython,
      typedGenerationArgs({ check: true }),
      consumerRoot,
      environment
    );
  } finally {
    fs.writeFileSync(backendPath, original, "utf8");
    run(
      isolatedPython,
      typedGenerationArgs(),
      consumerRoot,
      environment
    );
    run(
      isolatedPython,
      typedGenerationArgs({ check: true }),
      consumerRoot,
      environment
    );
    assert.equal(
      JSON.parse(fs.readFileSync(schemaPath, "utf8")).fingerprint,
      originalFingerprint,
      "restoring the contract must restore its deterministic fingerprint"
    );
  }
}

try {
  if (!configuredArtifactRoot && !publishedConfig) {
    if (process.env.FLUXFAST_SKIP_BUILD !== "1") {
      run(pnpmCommand, ["--filter", "@fluxfast/core", "build"]);
      run(pnpmCommand, ["--filter", "@fluxfast/next", "build"]);
    }
    fs.mkdirSync(artifactRoot, { recursive: true });
    run(npmCommand, [
      "pack",
      path.join(repositoryRoot, "packages", "core"),
      "--pack-destination",
      artifactRoot,
    ]);
    run(npmCommand, [
      "pack",
      path.join(repositoryRoot, "packages", "next"),
      "--pack-destination",
      artifactRoot,
    ]);
  }

  fs.cpSync(fixtureRoot, consumerRoot, { recursive: true });
  const manifestPath = path.join(consumerRoot, "package.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (process.env.FLUXFAST_NEXT_VERSION) {
    manifest.dependencies.next = process.env.FLUXFAST_NEXT_VERSION;
  }
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  run(npmCommand, ["install", "--package-lock=false"], consumerRoot);
  if (publishedConfig) {
    await installWithRetry(
      npmCommand,
      [
        "install",
        "--package-lock=false",
        "--no-save",
        publishedConfig.coreSpec,
        publishedConfig.nextSpec,
      ],
      `${publishedConfig.coreSpec} and ${publishedConfig.nextSpec}`,
      consumerRoot,
      publishedConfig.retryJavaScript
    );
  } else {
    run(
      npmCommand,
      [
        "install",
        "--package-lock=false",
        "--no-save",
        findArtifact("core"),
        findArtifact("next"),
      ],
      consumerRoot
    );
  }
  const installedCoreVersion = assertIsolatedNpmPackage("@fluxfast/core");
  const installedNextVersion = assertIsolatedNpmPackage("@fluxfast/next");
  if (publishedConfig) {
    assert.equal(installedCoreVersion, publishedConfig.version);
    assert.equal(installedNextVersion, publishedConfig.version);
  }

  run(npxCommand, ["--no-install", "fluxfast", "--help"], consumerRoot);
  run(npxCommand, ["--no-install", "fluxfast", "init", "--dry-run"], consumerRoot);
  run(npmCommand, ["run", "verify:dry-run"], consumerRoot);
  run(npxCommand, ["--no-install", "fluxfast", "init", "--yes"], consumerRoot);
  run(npmCommand, ["run", "verify:init"], consumerRoot);
  const homeFixture = runDistributedConsumer
    ? "distributed-home.tsx"
    : runLiveConsumer || runProductionConsumer
      ? "typed-live-home.tsx"
      : "deferred-home.tsx";
  fs.copyFileSync(
    path.join(consumerRoot, "fixtures", homeFixture),
    path.join(consumerRoot, "src", "flux-pages", "home", "index.tsx")
  );
  if (runDistributedConsumer) {
    const detailsRoot = path.join(consumerRoot, "src", "flux-pages", "details");
    fs.mkdirSync(detailsRoot, { recursive: true });
    fs.copyFileSync(
      path.join(consumerRoot, "fixtures", "distributed-details.tsx"),
      path.join(detailsRoot, "index.tsx")
    );
  }
  const livePython = runLiveConsumer || runProductionConsumer
    ? await prepareIsolatedPython()
    : undefined;
  if (livePython) {
    run(
      livePython,
      typedGenerationArgs(),
      consumerRoot,
      { PYTHONPATH: "" }
    );
    assertTypedConsumerArtifacts();
    run(
      livePython,
      typedGenerationArgs({ check: true }),
      consumerRoot,
      { PYTHONPATH: "" }
    );
    verifyTypedSchemaDrift(livePython);
    assertTypedConsumerArtifacts();
  } else {
    run(npxCommand, ["--no-install", "fluxfast", "generate"], consumerRoot);
  }
  run(npxCommand, ["--no-install", "fluxfast", "init", "--check"], consumerRoot);
  run(npxCommand, ["--no-install", "fluxfast", "doctor"], consumerRoot);
  run(npmCommand, ["run", "typecheck"], consumerRoot);
  const productionFluxfast = runProductionConsumer
    ? isolatedFluxfastExecutable(livePython)
    : undefined;
  if (runProductionConsumer) {
    assert.equal(
      fs.existsSync(productionFluxfast),
      true,
      "the isolated wheel must install the fluxfast console command"
    );
    run(
      productionFluxfast,
      [
        "build",
        "--app",
        "backend:app",
        "--frontend",
        consumerRoot,
      ],
      consumerRoot,
      { PYTHONPATH: "" }
    );
    run(
      productionFluxfast,
      [
        "doctor",
        "--production",
        "--app",
        "backend:app",
        "--frontend",
        consumerRoot,
        "--backend-host",
        "127.0.0.1",
        "--workers",
        "1",
        "--strict",
      ],
      consumerRoot,
      { PYTHONPATH: "" }
    );
  } else {
    run(npmCommand, ["run", "build"], consumerRoot);
  }
  if (runLiveConsumer) {
    run(
      process.execPath,
      [path.join(repositoryRoot, "scripts", "test-next-init-live.mjs"), consumerRoot],
      repositoryRoot,
      { FLUXFAST_E2E_PYTHON: livePython, PYTHONPATH: "" }
    );
  }
  if (runProductionConsumer) {
    run(
      process.execPath,
      [
        path.join(repositoryRoot, "scripts", "test-next-init-live.mjs"),
        consumerRoot,
      ],
      repositoryRoot,
      {
        FLUXFAST_CONSUMER_PRODUCTION: "1",
        FLUXFAST_CONSUMER_PUBLISHED: publishedConfig ? "1" : "0",
        FLUXFAST_E2E_FLUXFAST: productionFluxfast,
        FLUXFAST_E2E_PYTHON: livePython,
        PYTHONPATH: "",
      }
    );
  }
  if (runDistributedConsumer) {
    const isolatedPython = await prepareIsolatedPython({ distributed: true });
    run(
      process.execPath,
      [path.join(repositoryRoot, "scripts", "test-next-init-distributed.mjs"), consumerRoot],
      repositoryRoot,
      { FLUXFAST_E2E_PYTHON: isolatedPython, PYTHONPATH: "" }
    );
  }

  const typed = runLiveConsumer || runProductionConsumer ? " typed" : "";
  const runtime = runProductionConsumer ? " production" : " initialization";
  console.log(
    `${publishedConfig ? "Published" : "Packed"}${typed} FluxFast${runtime} consumer passed `
      + `with Next.js ${manifest.dependencies.next}.`
  );
} finally {
  if (process.env.FLUXFAST_KEEP_TEMP === "1") {
    console.log(`Preserved consumer at ${consumerRoot}`);
  } else {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}
