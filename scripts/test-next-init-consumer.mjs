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

function run(command, args, cwd = repositoryRoot) {
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
    },
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited with status ${result.status}`);
  }
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

  run(npxCommand, ["--no-install", "fluxfast", "--help"], consumerRoot);
  run(npxCommand, ["--no-install", "fluxfast", "init", "--dry-run"], consumerRoot);
  run(npmCommand, ["run", "verify:dry-run"], consumerRoot);
  run(npxCommand, ["--no-install", "fluxfast", "init", "--yes"], consumerRoot);
  run(npmCommand, ["run", "verify:init"], consumerRoot);
  run(npxCommand, ["--no-install", "fluxfast", "generate"], consumerRoot);
  run(npxCommand, ["--no-install", "fluxfast", "init", "--check"], consumerRoot);
  run(npxCommand, ["--no-install", "fluxfast", "doctor"], consumerRoot);
  run(npmCommand, ["run", "typecheck"], consumerRoot);
  run(npmCommand, ["run", "build"], consumerRoot);

  console.log(`Packed FluxFast initialization consumer passed with Next.js ${manifest.dependencies.next}.`);
} finally {
  if (process.env.FLUXFAST_KEEP_TEMP === "1") {
    console.log(`Preserved consumer at ${consumerRoot}`);
  } else {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}
