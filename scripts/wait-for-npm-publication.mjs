import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

import { resolvePublishedProductionConfig } from "./published-production-config.mjs";

export const NPM_RELEASE_PACKAGES = Object.freeze([
  "core", "codegen", "react", "vite", "next", "devtools",
]);
const METADATA_FORMATS = ["application/json", "application/vnd.npm.install-v1+json"];

export function resolveNpmPublicationConfig({ version, attempts = "60" } = {}) {
  const common = resolvePublishedProductionConfig({ version });
  assert.ok(common, "A stable release version is required.");
  assert.ok(
    /^\d+$/.test(String(attempts)) && Number(attempts) >= 1 && Number(attempts) <= 60,
    "FLUXFAST_REGISTRY_PROPAGATION_ATTEMPTS must be an integer from 1 to 60."
  );
  return { version: common.version, attempts: Number(attempts) };
}

/** Version endpoints can be ready before the packuments used by npm install. */
export async function waitForNpmPublication(config, {
  fetch: fetcher = fetch, sleep = delay, log = console.log,
} = {}) {
  const records = NPM_RELEASE_PACKAGES.flatMap(packageName => {
    const name = `@fluxfast/${packageName}`;
    return METADATA_FORMATS.map(accept => ({ name, accept,
      url: `https://registry.npmjs.org/${encodeURIComponent(name)}` }));
  });
  for (let attempt = 1; attempt <= config.attempts; attempt += 1) {
    const missing = (await Promise.all(records.map(async ({ name, url, accept }) => {
      const response = await fetcher(url, {
        headers: { accept }, signal: AbortSignal.timeout(10_000),
      });
      if (response.status !== 200) await response.body?.cancel();
      if (response.status === 404) return name;
      assert.equal(response.status, 200,
        `${name} registry returned HTTP ${response.status}; not a propagation retry`);
      const metadata = await response.json();
      assert.equal(metadata.name, name, `${name} registry returned the wrong package`);
      assert.ok(metadata.versions && typeof metadata.versions === "object"
        && !Array.isArray(metadata.versions), `${name} registry returned malformed versions`);
      if (!Object.hasOwn(metadata.versions, config.version)) return name;
      const published = metadata.versions[config.version];
      assert.equal(published?.version, config.version, `${name} registry returned the wrong version`);
      assert.equal(published.name, name, `${name} version metadata names the wrong package`);
      assert.ok(typeof published.dist?.tarball === "string"
        && published.dist.tarball.startsWith("https://registry.npmjs.org/")
        && typeof published.dist.integrity === "string" && published.dist.integrity.length > 0,
        `${name} registry returned malformed distribution metadata`);
      return undefined;
    }))).filter(Boolean);
    if (missing.length === 0) {
      log(`All six npm packages for ${config.version} are ready for installation.`);
      return;
    }
    const names = [...new Set(missing)].join(", ");
    assert.ok(attempt < config.attempts,
      `Release ${config.version} did not propagate to npm install metadata: ${names}`);
    log(`Waiting for ${config.version} npm install metadata (${attempt}/${config.attempts}): ${names}`);
    await sleep(5_000);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assert.equal(process.argv.length, 3, "Usage: node scripts/wait-for-npm-publication.mjs vMAJOR.MINOR.PATCH");
  await waitForNpmPublication(resolveNpmPublicationConfig({
    version: process.argv[2], attempts: process.env.FLUXFAST_REGISTRY_PROPAGATION_ATTEMPTS,
  }));
}
