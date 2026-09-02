import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const frontendRoot = path.join(repositoryRoot, "tests", "browser", "frontend");
const containerEngine = process.env.FLUXFAST_COMPOSE_ENGINE ?? "docker";
const engineName = path.basename(containerEngine).toLowerCase();
const isPodman = engineName === "podman";
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const identifier = `${process.pid}-${Date.now()}`;
const securitySentinel = `fluxfast-security-${identifier}`;
const project = `fluxfast-compose-${identifier}`;
let composeCreated = false;
let appStopped = false;
let podmanService;
let podmanSocketPath;

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
    env: composeEnvironment,
    stdio: "inherit",
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw commandFailure(command, args, result);
}

function output(command, args) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    env: composeEnvironment,
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw commandFailure(command, args, result);
  return result.stdout.trim();
}

function composeArgs(...args) {
  return [
    "compose",
    "--project-name",
    project,
    "--file",
    "compose.yaml",
    ...args,
  ];
}

function composeOutput(...args) {
  return output(containerEngine, composeArgs(...args));
}

function composeExecute(...args) {
  execute(containerEngine, composeArgs(...args));
}

function findAvailablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      const { port } = address;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

const publicPort = await findAvailablePort();
const composeEnvironment = {
  ...process.env,
  FLUXFAST_COMPOSE_PORT: String(publicPort),
  FLUXFAST_SECURITY_SENTINEL: securitySentinel,
  NEXT_TELEMETRY_DISABLED: "1",
};
delete composeEnvironment.FLUXFAST_BACKEND_URL;
delete composeEnvironment.NEXT_PUBLIC_FLUXFAST_BACKEND_URL;

function verifyContainerEngine() {
  if (!isPodman) return;
  assert.notEqual(process.getuid?.(), 0, "Podman must run as an unprivileged user");
  const info = JSON.parse(output(containerEngine, ["info", "--format", "json"]));
  assert.equal(info.host?.security?.rootless, true, "Podman must run rootlessly");
  assert.equal(
    info.host?.serviceIsRemote,
    false,
    "the Podman Compose test must use the local rootless engine",
  );
  podmanSocketPath = info.host?.remoteSocket?.path;
  assert.equal(typeof podmanSocketPath, "string");
  assert.ok(
    podmanSocketPath.startsWith(`/run/user/${process.getuid?.()}/`),
    "the Podman API socket must be private to the unprivileged host user",
  );
  console.log(`✓ Podman Compose uses local rootless Podman as host UID ${process.getuid?.()}`);
}

async function waitFor(description, check, timeoutMs = 180_000) {
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

async function startPodmanComposeService() {
  if (!isPodman || fs.existsSync(podmanSocketPath)) return;
  fs.mkdirSync(path.dirname(podmanSocketPath), {
    recursive: true,
    mode: 0o700,
  });
  podmanService = spawn(
    containerEngine,
    ["system", "service", "--time=0", `unix://${podmanSocketPath}`],
    {
      cwd: repositoryRoot,
      env: composeEnvironment,
      stdio: ["ignore", "inherit", "inherit"],
    },
  );
  await waitFor("the temporary rootless Podman API socket", () => {
    if (podmanService.exitCode !== null) {
      throw new Error(`Podman service exited with status ${podmanService.exitCode}`);
    }
    return fs.existsSync(podmanSocketPath);
  }, 15_000);
  console.log("✓ started a temporary user-scoped Podman service for Compose");
}

async function stopPodmanComposeService() {
  if (!podmanService || podmanService.exitCode !== null) return;
  podmanService.kill("SIGTERM");
  await Promise.race([
    new Promise(resolve => podmanService.once("exit", resolve)),
    new Promise(resolve => setTimeout(resolve, 5_000)),
  ]);
  if (podmanService.exitCode === null) podmanService.kill("SIGKILL");
}

function verifyComposeConfig() {
  composeExecute("config", "--quiet");
  const services = composeOutput("config", "--services")
    .split("\n")
    .filter(Boolean)
    .sort();
  assert.deepEqual(services, ["app", "redis"]);
  console.log(`✓ ${engineName} compose config defines one application service plus Redis`);
}

function serviceContainer(service, { all = false } = {}) {
  const containers = composeOutput("ps", "--quiet", ...(all ? ["--all"] : []), service)
    .split("\n")
    .filter(Boolean);
  assert.equal(containers.length, 1, `${service} must have exactly one container`);
  return containers[0];
}

function listeningAddresses(containerId, port) {
  const script = [
    "const fs=require('node:fs');",
    "const port=Number(process.argv[1]);",
    "const files=['/proc/net/tcp','/proc/net/tcp6'];",
    "const addresses=[];",
    "for(const file of files){",
    "if(!fs.existsSync(file))continue;",
    "for(const line of fs.readFileSync(file,'utf8').trim().split('\\n').slice(1)){",
    "const fields=line.trim().split(/\\s+/);",
    "if(fields[3]!=='0A')continue;",
    "const [address,hexPort]=fields[1].split(':');",
    "if(Number.parseInt(hexPort,16)===port)addresses.push(address);",
    "}}",
    "process.stdout.write(JSON.stringify(addresses));",
  ].join("");
  return JSON.parse(output(containerEngine, [
    "exec",
    containerId,
    "node",
    "-e",
    script,
    String(port),
  ]));
}

function inspectTopology() {
  const app = serviceContainer("app", { all: true });
  const redis = serviceContainer("redis");
  const appInspection = JSON.parse(output(containerEngine, ["inspect", app]))[0];
  const redisInspection = JSON.parse(output(containerEngine, ["inspect", redis]))[0];
  assert.deepEqual(
    Object.keys(appInspection.HostConfig.PortBindings ?? {}),
    ["3000/tcp"],
    "the application must publish only its Next.js port",
  );
  assert.deepEqual(
    redisInspection.HostConfig.PortBindings ?? {},
    {},
    "Redis must remain private to the Compose network",
  );
  assert.equal(appInspection.HostConfig.ReadonlyRootfs, true);
  assert.equal(appInspection.HostConfig.Privileged, false);
  assert.ok(
    (appInspection.HostConfig.SecurityOpt ?? []).some(value =>
      value.includes("no-new-privileges"),
    ),
    "the Compose application must prevent privilege escalation",
  );
  for (const mount of appInspection.Mounts ?? []) {
    const rendered = JSON.stringify(mount).toLowerCase();
    assert.equal(rendered.includes("docker.sock"), false);
    assert.equal(rendered.includes("podman.sock"), false);
  }
  assert.equal(
    (appInspection.Config.Env ?? []).some(value => value.includes(securitySentinel)),
    false,
    "the host environment must not leak into the Compose application",
  );
  const uid = output(containerEngine, ["exec", app, "id", "-u"]);
  assert.notEqual(uid, "0", "the Compose application must run as non-root");
  const capabilityStatus = output(containerEngine, [
    "exec",
    app,
    "node",
    "-e",
    "process.stdout.write(require('node:fs').readFileSync('/proc/1/status', 'utf8'))",
  ]);
  const capabilities = Object.fromEntries(
    [...capabilityStatus.matchAll(/^(Cap(?:Inh|Prm|Eff|Bnd|Amb)):\s+([0-9a-f]+)$/gim)].map(
      ([, name, mask]) => [name, mask],
    ),
  );
  for (const name of ["CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"]) {
    assert.match(
      capabilities[name] ?? "",
      /^0+$/,
      `the Compose capability mask ${name} must be empty`,
    );
  }
  const backendAddresses = listeningAddresses(app, 8123);
  assert.ok(
    backendAddresses.includes("0100007F"),
    `FastAPI must listen on 127.0.0.1:8123, got ${backendAddresses.join(", ")}`,
  );
  assert.equal(backendAddresses.includes("00000000"), false);
  console.log("✓ app is non-root, read-only, capability-free, and socket-free");
  console.log("✓ app publishes only port 3000 and keeps loopback FastAPI and Redis private");
}

async function verifyPublicApplication(baseURL) {
  await waitFor("the Compose readiness endpoint", async () => {
    const response = await fetch(`${baseURL}/_fluxfast/readyz`);
    return response.ok;
  });
  const health = await fetch(`${baseURL}/_fluxfast/healthz`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: "ok" });

  const readiness = await fetch(`${baseURL}/_fluxfast/readyz`);
  assert.equal(readiness.status, 200);
  assert.deepEqual(await readiness.json(), { status: "ready" });

  const home = await fetch(`${baseURL}/distributed-live`);
  assert.equal(home.status, 200);
  assert.match(await home.text(), /Distributed live dashboard/);

  const app = serviceContainer("app");
  await waitFor("the Compose application health check", () => {
    if (isPodman) {
      const result = spawnSync(containerEngine, ["healthcheck", "run", app], {
        cwd: repositoryRoot,
        env: composeEnvironment,
        encoding: "utf8",
      });
      if (result.error) throw result.error;
      if (result.status === 0) return true;
      if (result.status === 1) return false;
      throw commandFailure(containerEngine, ["healthcheck", "run", app], result);
    }
    const state = JSON.parse(output(containerEngine, ["inspect", app]))[0]?.State;
    return state?.Health?.Status === "healthy";
  });
  console.log("✓ Compose readiness, health, and SSR respond through one public origin");
}

function runDistributedBrowser(baseURL) {
  execute(
    pnpm,
    [
      "--dir",
      frontendRoot,
      "exec",
      "playwright",
      "test",
      "--config",
      "playwright.compose.config.ts",
    ],
    {
      env: {
        ...composeEnvironment,
        FLUXFAST_COMPOSE_BASE_URL: baseURL,
      },
    },
  );
  console.log("✓ three FastAPI workers synchronized a Live Resource through Redis");
}

function stopApplicationGracefully() {
  composeExecute("stop", "--timeout", "25", "app");
  appStopped = true;
  const app = serviceContainer("app", { all: true });
  const state = JSON.parse(output(containerEngine, ["inspect", app]))[0]?.State;
  assert.equal(state?.Running, false);
  assert.equal(state?.ExitCode, 0, "Compose SIGTERM shutdown must exit cleanly");
  const logs = composeOutput("logs", "--no-color", "app");
  assert.match(logs, /\[fluxfast\] FastAPI: 127\.0\.0\.1:8123/);
  assert.match(logs, /\[fluxfast\] FastAPI workers: 3/);
  assert.match(logs, /\[fluxfast\] application ready/);
  assert.equal(logs.includes(securitySentinel), false);
  console.log(`✓ ${engineName} compose stop produced a clean FluxFast shutdown`);
}

function cleanup() {
  spawnSync(containerEngine, composeArgs(
    "down",
    "--volumes",
    "--remove-orphans",
    "--rmi",
    "local",
  ), {
    cwd: repositoryRoot,
    env: composeEnvironment,
    stdio: "ignore",
  });
}

try {
  verifyContainerEngine();
  await startPodmanComposeService();
  verifyComposeConfig();
  composeExecute("up", "--detach", "--build");
  composeCreated = true;
  const baseURL = `http://127.0.0.1:${publicPort}`;
  await verifyPublicApplication(baseURL);
  inspectTopology();
  runDistributedBrowser(baseURL);
  stopApplicationGracefully();
} catch (error) {
  if (composeCreated) {
    const logs = spawnSync(containerEngine, composeArgs("logs", "--no-color"), {
      cwd: repositoryRoot,
      env: composeEnvironment,
      encoding: "utf8",
    });
    if (logs.stdout) console.error(logs.stdout.trim());
    if (logs.stderr) console.error(logs.stderr.trim());
  }
  throw error;
} finally {
  if (composeCreated && !appStopped) {
    spawnSync(containerEngine, composeArgs("stop", "--timeout", "5", "app"), {
      cwd: repositoryRoot,
      env: composeEnvironment,
      stdio: "ignore",
    });
  }
  cleanup();
  await stopPodmanComposeService();
}
