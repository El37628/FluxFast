import assert from "node:assert/strict";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const frontendRoot = path.join(repositoryRoot, "tests", "browser", "frontend");
const docker = process.env.FLUXFAST_CONTAINER_ENGINE ?? "docker";
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const identifier = `${process.pid}-${Date.now()}`;
const image = `fluxfast-production-test:${identifier}`;
const container = `fluxfast-production-test-${identifier}`;
let imageBuilt = false;
let containerCreated = false;
let containerRunning = false;

function commandFailure(command, args, result) {
  const rendered = [command, ...args].join(" ");
  const details = [result.stdout, result.stderr].filter(Boolean).join("\n");
  return new Error(
    `${rendered} exited with status ${result.status ?? "unknown"}` +
      (details ? `\n${details.trim()}` : ""),
  );
}

function execute(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    env: process.env,
    stdio: "inherit",
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw commandFailure(command, args, result);
}

function output(command, args) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    env: process.env,
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw commandFailure(command, args, result);
  return result.stdout.trim();
}

function removeGeneratedArtifacts() {
  if (containerCreated) {
    spawnSync(docker, ["rm", "--force", container], { stdio: "ignore" });
  }
  if (imageBuilt) {
    spawnSync(docker, ["image", "rm", "--force", image], { stdio: "ignore" });
  }
}

async function waitFor(description, check, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(
    `Timed out waiting for ${description}` +
      (lastError instanceof Error ? `: ${lastError.message}` : ""),
  );
}

function inspectImage() {
  const inspected = JSON.parse(output(docker, ["image", "inspect", image]))[0];
  assert.ok(inspected, "Docker image inspection returned no image");
  assert.deepEqual(
    Object.keys(inspected.Config.ExposedPorts ?? {}),
    ["3000/tcp"],
    "the image must expose only its public port",
  );
  assert.notEqual(inspected.Config.User, "", "the image must declare a user");
  assert.notEqual(inspected.Config.User, "0", "the image must not run as UID 0");
  assert.notEqual(inspected.Config.User, "root", "the image must not run as root");
  console.log(`✓ image declares non-root user ${inspected.Config.User}`);
  console.log("✓ image exposes only 3000/tcp");
}

function mappedPublicPort() {
  const mapping = output(docker, ["port", container, "3000/tcp"])
    .split("\n")
    .find(Boolean);
  const match = mapping?.match(/:(\d+)$/);
  assert.ok(match, `could not parse the public port mapping: ${mapping ?? "none"}`);
  return Number(match[1]);
}

function inspectRuntime() {
  const inspected = JSON.parse(output(docker, ["inspect", container]))[0];
  assert.ok(inspected, "Docker container inspection returned no container");
  assert.equal(inspected.HostConfig.ReadonlyRootfs, true);
  assert.deepEqual(
    Object.keys(inspected.HostConfig.PortBindings ?? {}),
    ["3000/tcp"],
    "the internal FastAPI port must not be published",
  );
  assert.ok(
    (inspected.HostConfig.CapDrop ?? []).includes("ALL"),
    "the runtime must drop Linux capabilities",
  );
  assert.ok(
    (inspected.HostConfig.SecurityOpt ?? []).some(value =>
      value.includes("no-new-privileges"),
    ),
    "the runtime must prevent privilege escalation",
  );

  const uid = output(docker, ["exec", container, "id", "-u"]);
  const gid = output(docker, ["exec", container, "id", "-g"]);
  assert.notEqual(uid, "0", "the running container must not use UID 0");
  assert.notEqual(gid, "0", "the running container must not use GID 0");

  const pidOne = output(docker, [
    "exec",
    container,
    "node",
    "-e",
    "process.stdout.write(require('node:fs').readFileSync('/proc/1/cmdline').toString().replaceAll('\\0', ' ').trim())",
  ]);
  assert.match(pidOne, /fluxfast start tests\.browser\.backend:app/);
  console.log(`✓ runtime uses non-root UID:GID ${uid}:${gid}`);
  console.log("✓ FluxFast supervisor is container PID 1");
  console.log("✓ root filesystem is read-only and the backend port is private");
}

async function verifyPublicApplication(baseURL) {
  await waitFor("the public readiness endpoint", async () => {
    const response = await fetch(`${baseURL}/_fluxfast/readyz`);
    return response.ok;
  });

  const readiness = await fetch(`${baseURL}/_fluxfast/readyz`);
  assert.equal(readiness.status, 200);
  assert.deepEqual(await readiness.json(), { status: "ready" });

  const home = await fetch(`${baseURL}/`);
  assert.equal(home.status, 200);
  assert.match(await home.text(), /Control Center/);

  await waitFor("the image health check", () => {
    const state = JSON.parse(output(docker, ["inspect", container]))[0]?.State;
    return state?.Health?.Status === "healthy";
  });
  console.log("✓ public readiness, health check, and SSR respond on port 3000");
}

function runBrowser(baseURL) {
  execute(
    pnpm,
    [
      "--dir",
      frontendRoot,
      "exec",
      "playwright",
      "test",
      "--config",
      "playwright.container.config.ts",
    ],
    {
      env: {
        ...process.env,
        FLUXFAST_CONTAINER_BASE_URL: baseURL,
      },
    },
  );
}

function stopGracefully() {
  execute(docker, ["stop", "--timeout", "25", container]);
  containerRunning = false;
  const state = JSON.parse(output(docker, ["inspect", container]))[0]?.State;
  assert.equal(state?.Running, false);
  assert.equal(state?.ExitCode, 0, "SIGTERM shutdown must exit cleanly");
  const logs = output(docker, ["logs", container]);
  assert.match(logs, /\[fluxfast\] FastAPI: 127\.0\.0\.1:8123/);
  assert.match(logs, /\[fluxfast\] application ready/);
  console.log("✓ docker stop produced a clean FluxFast shutdown");
}

try {
  execute(docker, ["build", "--tag", image, "--file", "Dockerfile", "."]);
  imageBuilt = true;
  inspectImage();

  output(docker, [
    "run",
    "--detach",
    "--name",
    container,
    "--read-only",
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,size=64m",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--publish",
    "127.0.0.1::3000",
    image,
  ]);
  containerCreated = true;
  containerRunning = true;

  const baseURL = `http://127.0.0.1:${mappedPublicPort()}`;
  await verifyPublicApplication(baseURL);
  inspectRuntime();
  runBrowser(baseURL);
  stopGracefully();
} catch (error) {
  if (containerCreated) {
    const logs = spawnSync(docker, ["logs", container], { encoding: "utf8" });
    if (logs.stdout) console.error(logs.stdout.trim());
    if (logs.stderr) console.error(logs.stderr.trim());
  }
  throw error;
} finally {
  if (containerRunning) {
    spawnSync(docker, ["stop", "--timeout", "5", container], {
      stdio: "ignore",
    });
  }
  removeGeneratedArtifacts();
}
