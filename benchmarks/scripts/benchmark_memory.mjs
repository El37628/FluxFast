/** Measure retained-heap trends while enforcing bounded client resource state. */

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = process.env.FLUXFAST_BENCHMARK_REPOSITORY_ROOT
  ? path.resolve(process.env.FLUXFAST_BENCHMARK_REPOSITORY_ROOT)
  : path.resolve(scriptDirectory, "../..");
const requireFromRepository = createRequire(
  path.join(repositoryRoot, "package.json")
);
const {
  FluxRouter,
  LiveManager,
  ResourceStore,
  createValidator,
} = requireFromRepository("./packages/core/dist/index.js");

function parseArguments(argv) {
  const options = { cycles: 100, samples: 5 };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") continue;
    if (argument !== "--cycles" && argument !== "--samples") {
      throw new TypeError(`Unknown option: ${argument}`);
    }
    const value = Number(argv[index + 1]);
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError(`${argument} must be a positive integer`);
    }
    options[argument.slice(2)] = value;
    index += 1;
  }
  return options;
}

function collectHeap() {
  globalThis.gc();
  return process.memoryUsage().heapUsed;
}

function formatBytes(value) {
  const sign = value < 0 ? "-" : "+";
  return `${sign}${(Math.abs(value) / 1024).toFixed(1)} KiB`;
}

function trend(values) {
  if (values.length < 2) return 0;
  return (values.at(-1) - values[0]) / (values.length - 1);
}

function privateSize(owner, key) {
  const value = owner[key];
  assert.ok(value instanceof Map || value instanceof Set || Array.isArray(value));
  return value.size ?? value.length;
}

async function measureScenario(name, samples, operation) {
  await operation();
  const baseline = collectHeap();
  const heap = [];
  for (let sample = 0; sample < samples; sample += 1) {
    await operation();
    heap.push(collectHeap());
  }
  const retained = heap.at(-1) - baseline;
  console.log(
    `${name}: retained ${formatBytes(retained)}; per-sample trend ${formatBytes(trend(heap))}; heap samples ${heap.map(value => `${(value / 1024 / 1024).toFixed(2)} MiB`).join(", ")}`,
  );
}

function createTransport() {
  let version = 0;
  return {
    async visit(request) {
      version += 1;
      const key = request.only?.[0] ?? "summary";
      return {
        protocol: "fluxfast/1",
        page: {
          component: "benchmark/index",
          url: request.url,
        },
        resources: {
          [key]: { version: `v${version}`, value: { version } },
        },
        resourceKeys: [key],
      };
    },
    async mutate() {
      version += 1;
      return {
        protocol: "fluxfast/1",
        mutation: {
          patches: {
            counter: [{ op: "replace-resource", value: { version } }],
          },
        },
      };
    },
  };
}

async function navigationCycles(cycles) {
  const router = new FluxRouter({
    deferHistory: true,
    maxPages: 8,
    maxResources: 32,
    transport: createTransport(),
  });
  try {
    for (let index = 0; index < cycles; index += 1) {
      await router.visit(`/memory/page-${index}`, {
        preserveState: true,
        usePrefetch: false,
      });
    }
    assert.equal(
      router.pageStore.getSnapshot().url,
      `/memory/page-${cycles - 1}`,
    );
    assert.ok(privateSize(router.pageCache, "entries") <= 8);
    assert.ok(privateSize(router.resourceStore, "records") <= 32);
  } finally {
    router.destroy();
  }
}

async function deferredCycles(cycles) {
  const router = new FluxRouter({
    deferHistory: true,
    transport: createTransport(),
    initialPage: { component: "benchmark/index", url: "/memory/deferred" },
  });
  try {
    for (let index = 0; index < cycles; index += 1) {
      await router.loadResources(["deferred"], {
        reason: "deferred",
        url: "/memory/deferred",
      });
    }
    assert.equal(
      router.resourceStore.getStateSnapshot("deferred").status,
      "ready",
    );
    assert.equal(privateSize(router.resourceStore, "records"), 1);
  } finally {
    router.destroy();
  }
}

async function mutationCycles(cycles) {
  const router = new FluxRouter({
    deferHistory: true,
    transport: createTransport(),
    initialPage: { component: "benchmark/index", url: "/memory/mutations" },
    initialResources: {
      counter: { version: "v0", value: { version: 0 } },
    },
  });
  try {
    for (let index = 0; index < cycles; index += 1) {
      await router.mutate("/memory/mutations", { index });
    }
    assert.equal(router.resourceStore.getSnapshot("counter").version, cycles);
    assert.equal(privateSize(router.resourceStore, "records"), 1);
  } finally {
    router.destroy();
  }
}

class IdleConnection {
  constructor(onClose) {
    this.controller = new AbortController();
    this.onClose = onClose;
    this.closed = false;
  }

  get signal() {
    return this.controller.signal;
  }

  close(reason) {
    if (this.closed) return;
    this.closed = true;
    this.controller.abort(reason);
    this.onClose();
  }

  async *[Symbol.asyncIterator]() {
    if (this.signal.aborted) return;
    await new Promise(resolve => {
      this.signal.addEventListener("abort", resolve, { once: true });
    });
  }
}

async function liveReconnectCycles(cycles) {
  const state = { active: 0, maximum: 0, networkSubscriptions: 0 };
  const manager = new LiveManager({
    clientId: "memory-benchmark-client",
    network: {
      isOnline: () => true,
      subscribe: () => {
        state.networkSubscriptions += 1;
        return () => {
          state.networkSubscriptions -= 1;
        };
      },
    },
    reconnectJitter: 0,
    transport: {
      connect: () => {
        state.active += 1;
        state.maximum = Math.max(state.maximum, state.active);
        return new IdleConnection(() => {
          state.active -= 1;
        });
      },
    },
  });
  manager.updateManifest("/memory/live", ["summary"]);
  manager.connect();
  for (let index = 0; index < cycles; index += 1) {
    manager.reconnect();
  }
  manager.destroy();
  await Promise.resolve();
  assert.equal(state.active, 0);
  assert.equal(state.networkSubscriptions, 0);
  assert.equal(state.maximum, 1);
  assert.equal(privateSize(manager, "subscribers"), 0);
}

async function resourceStoreCycles(cycles) {
  const maxResources = 256;
  const store = new ResourceStore({ maxResources });
  const entries = cycles * 100;
  for (let index = 0; index < entries; index += 1) {
    store.set({
      key: `resource-${index}`,
      version: `v${index}`,
      value: { index, payload: "x".repeat(128) },
    });
  }
  assert.equal(privateSize(store, "records"), maxResources);
  assert.equal(privateSize(store, "stateSnapshots"), maxResources);
  assert.equal(privateSize(store, "lruOrder"), maxResources);
  assert.equal(store.getRecord("resource-0"), undefined);
  assert.equal(
    store.getRecord(`resource-${entries - 1}`).value.index,
    entries - 1,
  );
  store.clear();
  assert.equal(privateSize(store, "records"), 0);
  assert.equal(privateSize(store, "stateSnapshots"), 0);
}

async function validationCycles(cycles) {
  const validator = createValidator({
    kind: "object",
    properties: {
      id: { kind: "integer", minimum: 0 },
      label: { kind: "string", minLength: 1 },
    },
    required: ["id", "label"],
    additionalProperties: false,
  });
  for (let index = 0; index < cycles * 100; index += 1) {
    const valid = validator.validate({ id: index, label: `item-${index}` });
    assert.equal(valid.valid, true);
    const invalid = validator.validate({ id: -1, label: "" });
    assert.equal(invalid.valid, false);
    assert.equal(invalid.issues.length, 2);
  }
}

async function runBenchmark(samples, cycles) {
  assert.equal(
    typeof globalThis.gc,
    "function",
    "Run this benchmark with node --expose-gc",
  );
  console.log("FluxFast controlled client memory/resource benchmark");
  console.log(
    `environment: Node ${process.versions.node}; packages ${repositoryRoot}`,
  );
  console.log(
    `workload: ${samples} retained-heap samples after one warm-up; ${cycles} cycles per navigation/deferred/mutation/live batch; ${cycles * 100} ResourceStore inserts and valid+invalid validation pairs per batch`,
  );
  await measureScenario("navigation", samples, () => navigationCycles(cycles));
  await measureScenario("deferred loads", samples, () => deferredCycles(cycles));
  await measureScenario("mutation cycles", samples, () => mutationCycles(cycles));
  await measureScenario("live reconnects", samples, () =>
    liveReconnectCycles(cycles)
  );
  await measureScenario("large ResourceStore", samples, () =>
    resourceStoreCycles(cycles)
  );
  await measureScenario("validation calls", samples, () => validationCycles(cycles));
  console.log(
    "policy: heap values are diagnostic trend observations after forced collection, not exact-byte CI thresholds",
  );
  console.log(
    "correctness: PASS — page/resource stores stayed capped; deferred and mutation state converged; live connections and listeners returned to zero; large stores evicted to their configured bound; all validation outcomes remained exact",
  );
}

const { samples, cycles } = parseArguments(process.argv.slice(2));
await runBenchmark(samples, cycles);
