import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { resolvePublishedProductionConfig } from "./published-production-config.mjs";

export const REACT_RELEASE_PACKAGES = Object.freeze(["core", "codegen", "react", "vite", "devtools"]);

export function resolveReactPublishedConfig({ version, artifactDirectory, attempts = "60" } = {}) {
  const common = resolvePublishedProductionConfig({ version });
  if (!common) return undefined;
  if (artifactDirectory) throw new Error("FLUXFAST_PUBLISHED_VERSION and FLUXFAST_TYPES_ARTIFACT_DIR are mutually exclusive.");
  if (!/^\d+$/.test(String(attempts)) || Number(attempts) < 1 || Number(attempts) > 60) {
    throw new Error("FLUXFAST_REGISTRY_PROPAGATION_ATTEMPTS must be an integer from 1 to 60.");
  }
  return {
    version: common.version,
    pythonSpec: common.pythonSpec,
    npmSpecs: REACT_RELEASE_PACKAGES.map(name => `@fluxfast/${name}@${common.version}`),
    attempts: Number(attempts),
  };
}

/** Retry only missing versions during propagation, not auth/network/schema errors. */
export async function waitForReactPublication(config, { fetch: fetcher = fetch, sleep = delay, log = console.log } = {}) {
  const records = [
    ...REACT_RELEASE_PACKAGES.map(name => ({ name: `@fluxfast/${name}`,
      url: `https://registry.npmjs.org/${encodeURIComponent(`@fluxfast/${name}`)}/${config.version}`, read: data => data.version })),
    { name: "fluxfast", url: `https://pypi.org/pypi/fluxfast/${config.version}/json`, read: data => data.info?.version },
  ];
  for (let attempt = 1; attempt <= config.attempts; attempt += 1) {
    const missing = (await Promise.all(records.map(async record => {
      const response = await fetcher(record.url, { signal: AbortSignal.timeout(10_000) });
      if (response.status !== 200) await response.body?.cancel();
      if (response.status === 404) return record.name;
      assert.equal(response.status, 200, `${record.name} registry returned HTTP ${response.status}; not a propagation retry`);
      assert.equal(record.read(await response.json()), config.version, `${record.name} registry returned the wrong version`);
      return undefined;
    }))).filter(Boolean);
    if (missing.length === 0) return;
    assert.ok(attempt < config.attempts, `Release ${config.version} did not propagate: ${missing.join(", ")}`);
    log(`Waiting for ${config.version} registry propagation (${attempt}/${config.attempts}): ${missing.join(", ")}`);
    await sleep(5_000);
  }
}
