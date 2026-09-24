import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  FRESH_CONSUMER_FILES,
  extractFreshConsumerFiles,
} from "./fresh-consumer-docs.mjs";

const root = new URL("../", import.meta.url);
const read = name => fs.readFileSync(new URL(name, root), "utf8");

test("the public guide owns a complete fresh-consumer source set", () => {
  const guide = read("docs/getting-started.md");
  const files = extractFreshConsumerFiles(guide);
  assert.deepEqual([...files.keys()].toSorted(), FRESH_CONSUMER_FILES);

  const backend = files.get("backend/main.py");
  assert.match(backend, /flux\.define_resource\("site-summary", SiteSummary\)/);
  assert.match(backend, /@flux\.page\("\/", name="home"\)/);
  assert.match(backend, /@flux\.page\("\/about", name="about"\)/);
  assert.match(backend, /@flux\.mutation\("\/visits", name="increment_visits"\)/);
  assert.match(backend, /invalidate_resource\("site-summary", scope=scope\.public\(\)\)/);

  const home = files.get("frontend/src/flux-pages/home/index.tsx");
  assert.match(home, /useResource\(resourceKeys\.siteSummary\)/);
  assert.match(home, /IncrementVisitsBodyValidator/);
  assert.match(home, /mutations\.incrementVisits\(router/);

  const about = files.get("frontend/src/flux-pages/about/index.tsx");
  assert.match(about, /useResource\(resourceKeys\.siteSummary\)/);

  for (const command of [
    "python -m pip install fluxfast",
    "npx create-next-app@16 frontend",
    "npm install @fluxfast/next",
    "npx fluxfast init --yes",
    "fluxfast types backend.main:app --frontend frontend",
    "fluxfast types backend.main:app --frontend frontend --check",
    "fluxfast build --app backend.main:app --frontend frontend",
    "fluxfast start backend.main:app --frontend frontend",
  ]) {
    assert.ok(guide.includes(command), `missing documented command: ${command}`);
  }
});

test("fresh-consumer source markers cannot escape the temporary project", () => {
  assert.throws(
    () => extractFreshConsumerFiles([
      "<!-- fresh-consumer:path=../backend/main.py -->",
      "```python",
      "pass",
      "```",
    ].join("\n")),
    /Unsafe fresh-consumer documentation path/
  );
});

test("the fresh public guide is discoverable and continuously exercised", () => {
  assert.match(read("README.md"), /\[Getting Started\]\(docs\/getting-started\.md\)/);
  const manifest = JSON.parse(read("package.json"));
  assert.equal(
    manifest.scripts["test:consumer:stranger"],
    "node scripts/test-fresh-docs-consumer.mjs"
  );
  const workflow = read(".github/workflows/release-smoke.yml");
  assert.match(workflow, /name: Fresh documentation consumer/);
  assert.match(workflow, /run: pnpm run test:consumer:stranger/);
});
