import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import { setTimeout as delay } from "node:timers/promises";

async function assertAvailable(port, hostname) {
  const server = net.createServer();
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, hostname, resolve);
    });
  } catch (error) {
    throw new Error(`Adapter fixture port ${hostname}:${port} is already in use`, { cause: error });
  } finally {
    if (server.listening) await new Promise(resolve => server.close(resolve));
  }
}

async function boundedExit(exit, milliseconds) {
  let timer;
  try {
    return await Promise.race([
      exit,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("Adapter graceful shutdown timed out")), milliseconds);
      }),
    ]);
  } finally { clearTimeout(timer); }
}

/** Own a foreground host without attaching to or killing an unrelated server. */
export function createProcessHarness({
  name, baseUrl, readyUrl = baseUrl, command, args, cwd, env = process.env,
  additionalPorts = [], readinessTimeout = 120_000, shutdownTimeout = 15_000,
  requireZeroExit = false,
}) {
  const url = new URL(baseUrl);
  const ports = [Number(url.port || (url.protocol === "https:" ? 443 : 80)), ...additionalPorts];
  assert.ok(url.protocol === "http:" || url.protocol === "https:", "Adapter base URL must use HTTP or HTTPS");
  for (const port of ports) assert.ok(Number.isInteger(port) && port > 0 && port <= 65_535, "Adapter fixture ports must be valid nonzero TCP ports");
  for (const timeout of [readinessTimeout, shutdownTimeout]) assert.ok(Number.isFinite(timeout) && timeout > 0, "Adapter lifecycle timeouts must be positive");
  let owned;
  let starting;
  let stopping;
  const harness = {
    name,
    baseUrl,
    async start() {
      if (stopping) await stopping;
      if (starting) return starting;
      if (owned && !owned.result) return;
      starting = (async () => {
        for (const port of ports) await assertAvailable(port, url.hostname);
        const child = spawn(command, args, { cwd, env, shell: false, stdio: ["ignore", "pipe", "pipe"] });
        const record = { child, output: "", result: undefined, exit: undefined, ready: false };
        record.exit = new Promise(resolve => {
          child.once("error", error => { record.result = { error }; resolve(record.result); });
          child.once("exit", (code, signal) => { record.result = { code, signal }; resolve(record.result); });
        });
        for (const stream of [child.stdout, child.stderr]) {
          stream.on("data", chunk => {
            record.output = (record.output + chunk.toString()).slice(-64 * 1024);
            if (process.env.FLUXFAST_CONFORMANCE_VERBOSE === "1") process.stdout.write(chunk);
          });
        }
        owned = record;
        try {
          const deadline = Date.now() + readinessTimeout;
          while (Date.now() < deadline) {
            if (record.result) throw new Error(`Adapter ${name} exited before readiness`);
            try {
              const response = await fetch(readyUrl, { redirect: "manual", signal: AbortSignal.timeout(1_000) });
              await response.body?.cancel();
              if (response.ok && !record.result) { record.ready = true; return; }
            } catch { /* The owned host may still be starting. */ }
            await delay(100);
          }
          throw new Error(`Adapter ${name} readiness timed out`);
        } catch (error) {
          await harness.stop();
          throw new Error(`${error.message}\n${record.output}`, { cause: error });
        }
      })();
      try { await starting; } finally { starting = undefined; }
    },
    async stop() {
      if (stopping) return stopping;
      if (!owned) return;
      const record = owned;
      stopping = (async () => {
        try {
          if (!record.result) record.child.kill("SIGTERM");
          let result;
          try { result = await boundedExit(record.exit, shutdownTimeout); }
          catch (error) {
            record.child.kill("SIGKILL");
            await boundedExit(record.exit, 5_000);
            throw new Error(`${error.message}\n${record.output}`, { cause: error });
          }
          if (result.error) throw result.error;
          // Startup reports a pre-readiness failure; a later host failure still fails teardown.
          if (record.ready) {
            assert.ok(requireZeroExit
              ? result.code === 0 && result.signal === null
              : result.code === 0 || result.signal === "SIGTERM",
            `Adapter ${name} did not exit cleanly (${result.code ?? result.signal})\n${record.output}`);
          }
          for (const port of ports) await assertAvailable(port, url.hostname);
        } finally { owned = undefined; }
      })();
      try { await stopping; } finally { stopping = undefined; }
    },
  };
  return harness;
}
