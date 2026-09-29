/** Stress active DevTools diagnostics while enforcing structural memory bounds. */

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = process.env.FLUXFAST_BENCHMARK_REPOSITORY_ROOT
  ? path.resolve(process.env.FLUXFAST_BENCHMARK_REPOSITORY_ROOT)
  : path.resolve(scriptDirectory, "../..");
const requireFromRepository = createRequire(path.join(repositoryRoot, "package.json"));
const { FluxRouter } = requireFromRepository("./packages/core/dist/index.js");
const { DevtoolsStore } = requireFromRepository("./packages/devtools/dist/store.js");

const NAVIGATIONS = 1_000;
const RESOURCE_UPDATES = 1_000;
const MUTATIONS = 500;
const LIVE_RECONNECTS = 100;
const MAX_EVENTS = 500;
const MAX_RETAINED_BYTES = 32 * 1024 * 1024;
const MAX_TIMELINE_BYTES = 2 * 1024 * 1024;

function collectHeap() {
  globalThis.gc();
  return process.memoryUsage().heapUsed;
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

function createTransport() {
  let version = 0;
  return {
    async visit(request) {
      version += 1;
      const keys = request.only ?? ["summary"];
      return {
        protocol: "fluxfast/1",
        page: { component: "benchmark/index", url: request.url },
        resourceKeys: keys,
        resources: Object.fromEntries(keys.map(key => [
          key,
          { version: `v${version}`, value: { count: version } },
        ])),
        live: ["summary"],
      };
    },
    async mutate() {
      version += 1;
      return {
        protocol: "fluxfast/1",
        mutation: {
          patches: {
            summary: [{ op: "replace-resource", value: { count: version } }],
          },
        },
      };
    },
  };
}

async function run() {
  assert.equal(
    typeof globalThis.gc,
    "function",
    "Run this benchmark with node --expose-gc",
  );
  const liveState = { active: 0, maximum: 0 };
  const router = new FluxRouter({
    deferHistory: true,
    liveTransport: {
      connect: () => {
        liveState.active += 1;
        liveState.maximum = Math.max(liveState.maximum, liveState.active);
        return new IdleConnection(() => {
          liveState.active -= 1;
        });
      },
    },
    maxPages: 8,
    maxResources: 32,
    transport: createTransport(),
  });
  const store = new DevtoolsStore(router, MAX_EVENTS);
  let maximumTimeline = 0;
  let publications = 0;
  const unsubscribe = store.subscribe(() => {
    publications += 1;
    maximumTimeline = Math.max(maximumTimeline, store.getSnapshot().events.length);
  });
  const stop = store.start();
  assert.equal(router.diagnostics.active, true);
  const baselineHeap = collectHeap();

  for (let index = 0; index < NAVIGATIONS; index += 1) {
    await router.visit(`/devtools/navigation-${index}`, {
      preserveState: true,
      usePrefetch: false,
    });
  }
  for (let index = 0; index < RESOURCE_UPDATES; index += 1) {
    await router.loadResources(["summary"], {
      reason: "refresh",
      url: `/devtools/navigation-${NAVIGATIONS - 1}`,
    });
  }
  for (let index = 0; index < MUTATIONS; index += 1) {
    await router.mutate("/devtools/mutation", { index });
  }
  router.liveManager.updateManifest("/devtools/live", ["summary"]);
  router.liveManager.connect();
  for (let index = 0; index < LIVE_RECONNECTS; index += 1) {
    router.liveManager.reconnect();
  }
  await Promise.resolve();

  const snapshot = store.getSnapshot();
  const finalHeap = collectHeap();
  const retainedBytes = finalHeap - baselineHeap;
  const timelineBytes = Buffer.byteLength(JSON.stringify(snapshot.events));
  assert.equal(snapshot.events.length, MAX_EVENTS);
  assert.equal(maximumTimeline, MAX_EVENTS);
  assert.ok(snapshot.resources.length <= 32);
  assert.ok(timelineBytes <= MAX_TIMELINE_BYTES);
  assert.ok(
    retainedBytes <= MAX_RETAINED_BYTES,
    `DevTools retained ${(retainedBytes / 1024 / 1024).toFixed(2)} MiB`,
  );
  assert.equal(liveState.maximum, 1);

  store.clearTimeline();
  assert.equal(store.getSnapshot().events.length, 0);
  stop();
  unsubscribe();
  assert.equal(router.diagnostics.active, false);
  router.destroy();
  await Promise.resolve();
  assert.equal(liveState.active, 0);

  console.log("FluxFast active DevTools memory benchmark");
  console.log(
    `workload: ${NAVIGATIONS} navigations; ${RESOURCE_UPDATES} resource updates; ${MUTATIONS} mutations; ${LIVE_RECONNECTS} live reconnects`,
  );
  console.log(
    `result: timeline ${snapshot.events.length}/${MAX_EVENTS}; peak ${maximumTimeline}; serialized ${(timelineBytes / 1024).toFixed(1)} KiB; retained ${(retainedBytes / 1024 / 1024).toFixed(2)} MiB; publications ${publications}`,
  );
  console.log(
    "tradeoff: active development diagnostics allocate safe event projections, but the timeline and serialized trace remain capped and all subscriptions/connections are released",
  );
  console.log(
    "correctness: PASS — the complete long-running workload stayed inside the configured ring-buffer, serialized-size, resource, heap, listener, and connection bounds",
  );
}

await run();
