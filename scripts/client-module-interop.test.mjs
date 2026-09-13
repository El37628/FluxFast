import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const coreRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../packages/core");
const manifest = JSON.parse(fs.readFileSync(path.join(coreRoot, "package.json"), "utf8"));
const entry = manifest.exports["."];
const commonjs = createRequire(import.meta.url)(path.join(coreRoot, entry.require));
const esm = await import(pathToFileURL(path.join(coreRoot, entry.import)).href);

for (const [name, routerModule, prefetchModule] of [
  ["CJS router with ESM prefetch", commonjs, esm],
  ["ESM router with CJS prefetch", esm, commonjs],
]) {
  test(`${name} rejects obsolete frozen envelopes`, async () => {
    let settle;
    const router = new routerModule.FluxRouter({
      deferHistory: true,
      prefetchManager: new prefetchModule.PrefetchManager(),
      transport: {
        visit: () => new Promise(resolve => { settle = resolve; }),
        mutate: async () => ({ protocol: "fluxfast/1", mutation: { invalidate: ["shared"] } }),
      },
    });
    try {
      const work = router.prefetch("/obsolete");
      await router.mutate("/change");
      settle(Object.freeze({
        protocol: "fluxfast/1",
        page: { component: "lifecycle/index", url: "/obsolete" },
        resourceKeys: ["shared"],
        resources: { shared: { version: "old", value: -1 } },
      }));
      await work;
      assert.equal(router.resourceStore.getSnapshot("shared"), undefined);
      assert.equal(router.prefetchManager.getCached("/obsolete", {}), undefined);
    } finally {
      router.destroy();
    }
  });
}
