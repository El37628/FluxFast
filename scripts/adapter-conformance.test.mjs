import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import net from "node:net";
import test from "node:test";
import { createProcessHarness } from "../tests/adapter-conformance/process-harness.mjs";

async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

function fixture(port, source, options = {}) {
  return createProcessHarness({
    name: "test-host",
    baseUrl: `http://127.0.0.1:${port}`,
    command: process.execPath,
    args: ["--input-type=module", "-e", source],
    readinessTimeout: 5_000,
    shutdownTimeout: 5_000,
    ...options,
  });
}

test("adapter harness starts one owned process and stops it idempotently", async () => {
  const port = await freePort();
  const harness = fixture(port, `
    import http from 'node:http';
    const server = http.createServer((req, res) => res.end('ready'));
    server.listen(${port}, '127.0.0.1');
    process.on('SIGTERM', () => server.close(() => process.exit(0)));
  `);
  try {
    await Promise.all([harness.start(), harness.start()]);
    await harness.start();
    assert.equal(await (await fetch(harness.baseUrl)).text(), "ready");
  } finally {
    await harness.stop();
  }
  await harness.stop();
  await assert.rejects(fetch(harness.baseUrl));
});

test("adapter harness refuses to attach to an unrelated server", async () => {
  const port = await freePort();
  const unrelated = net.createServer();
  await new Promise(resolve => unrelated.listen(port, "127.0.0.1", resolve));
  try {
    const harness = fixture(port, "throw new Error('must not launch')");
    await assert.rejects(harness.start(), /already in use/);
    await harness.stop();
    assert.equal(unrelated.listening, true);
  } finally {
    await new Promise(resolve => unrelated.close(resolve));
  }
});

test("adapter harness reports premature host exit with bounded diagnostics", async () => {
  const harness = fixture(await freePort(), "console.error('fixture boot failed'); process.exit(7)");
  await assert.rejects(harness.start(), /fixture boot failed/);
  await harness.stop();
});

test("adapter readiness timeout cleans up the process before rejecting", async () => {
  const port = await freePort();
  const harness = fixture(port, "setInterval(() => {}, 1000)", { readinessTimeout: 300 });
  await assert.rejects(harness.start(), /readiness.*timed out/i);
  await harness.stop();
  const server = net.createServer();
  await new Promise(resolve => server.listen(port, "127.0.0.1", resolve));
  await new Promise(resolve => server.close(resolve));
});

test("adapter lifecycle refuses invalid ports and timeout configuration", () => {
  assert.throws(() => fixture(1, "", { additionalPorts: [0] }), /valid nonzero TCP ports/);
  assert.throws(() => fixture(1, "", { additionalPorts: [Number.NaN] }), /valid nonzero TCP ports/);
  assert.throws(() => fixture(1, "", { readinessTimeout: 0 }), /timeouts must be positive/);
});

test("adapter startup failure cleans up without trying to kill an unrelated process", async () => {
  const harness = fixture(await freePort(), "", { command: "/fluxfast-conformance-missing-executable" });
  await assert.rejects(harness.start(), /ENOENT/);
  await harness.stop();
});

test("forced shutdown releases the fixture port but cannot pass graceful-shutdown conformance", async () => {
  const port = await freePort();
  const harness = fixture(port, `
    import http from 'node:http';
    http.createServer((req, res) => res.end('ready')).listen(${port}, '127.0.0.1');
    process.on('SIGTERM', () => {});
  `, { shutdownTimeout: 200 });
  try {
    await harness.start();
    await assert.rejects(harness.stop(), /graceful shutdown timed out/);
    await assert.rejects(fetch(harness.baseUrl));
  } finally { await harness.stop(); }
});

test("container runner discovers the existing contract cases after the suite moves", () => {
  const output = execFileSync(process.platform === "win32" ? "pnpm.cmd" : "pnpm", [
    "--dir", "tests/browser/frontend", "exec", "playwright", "test",
    "--config", "playwright.container.config.ts", "--list",
  ], {
    encoding: "utf8",
    env: { ...process.env, FLUXFAST_CONTAINER_BASE_URL: "http://127.0.0.1:3000", FLUXFAST_E2E_PRODUCTION: "1" },
  });
  assert.match(output, /critical-flow\.spec\.ts/);
  assert.match(output, /live-flow\.spec\.ts/);
  assert.match(output, /Total: 17 tests in 2 files/);
});
