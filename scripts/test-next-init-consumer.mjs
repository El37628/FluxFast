import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureRoot = path.join(repositoryRoot, "tests", "release-consumer", "next-init");
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fluxfast-next-init-"));
const consumerRoot = path.join(temporaryRoot, "consumer");
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

function run(command, args, cwd = repositoryRoot, extraEnvironment = {}) {
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
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited with status ${result.status}`);
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

function prepareIsolatedPython() {
  fs.mkdirSync(artifactRoot, { recursive: true });
  const environmentRoot = path.join(temporaryRoot, "python-environment");
  run(pythonCommand, ["-m", "venv", environmentRoot]);
  const isolatedPython = process.platform === "win32"
    ? path.join(environmentRoot, "Scripts", "python.exe")
    : path.join(environmentRoot, "bin", "python");
  run(isolatedPython, ["-m", "ensurepip", "--upgrade"]);

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

  run(
    isolatedPython,
    ["-m", "pip", "install", findPythonArtifact()],
    consumerRoot,
    { PYTHONPATH: "" }
  );
  run(
    isolatedPython,
    [
      "-c",
      "import sys; from pathlib import Path; import fluxfast; "
        + "assert Path(fluxfast.__file__).resolve().is_relative_to(Path(sys.prefix).resolve())",
    ],
    consumerRoot,
    { PYTHONPATH: "" }
  );
  return isolatedPython;
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
}

try {
  if (!configuredArtifactRoot) {
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
  assertIsolatedNpmPackage("@fluxfast/core");
  assertIsolatedNpmPackage("@fluxfast/next");

  run(npxCommand, ["--no-install", "fluxfast", "--help"], consumerRoot);
  run(npxCommand, ["--no-install", "fluxfast", "init", "--dry-run"], consumerRoot);
  run(npmCommand, ["run", "verify:dry-run"], consumerRoot);
  run(npxCommand, ["--no-install", "fluxfast", "init", "--yes"], consumerRoot);
  run(npmCommand, ["run", "verify:init"], consumerRoot);
  fs.copyFileSync(
    path.join(consumerRoot, "fixtures", "deferred-home.tsx"),
    path.join(consumerRoot, "src", "flux-pages", "home", "index.tsx")
  );
  run(npxCommand, ["--no-install", "fluxfast", "generate"], consumerRoot);
  run(npxCommand, ["--no-install", "fluxfast", "init", "--check"], consumerRoot);
  run(npxCommand, ["--no-install", "fluxfast", "doctor"], consumerRoot);
  run(npmCommand, ["run", "typecheck"], consumerRoot);
  run(npmCommand, ["run", "build"], consumerRoot);
  if (process.env.FLUXFAST_RUN_LIVE === "1") {
    const isolatedPython = prepareIsolatedPython();
    run(
      process.execPath,
      [path.join(repositoryRoot, "scripts", "test-next-init-live.mjs"), consumerRoot],
      repositoryRoot,
      { FLUXFAST_E2E_PYTHON: isolatedPython, PYTHONPATH: "" }
    );
  }

  console.log(`Packed FluxFast initialization consumer passed with Next.js ${manifest.dependencies.next}.`);
} finally {
  if (process.env.FLUXFAST_KEEP_TEMP === "1") {
    console.log(`Preserved consumer at ${consumerRoot}`);
  } else {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}
