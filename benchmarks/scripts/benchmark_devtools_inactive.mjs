/** Measure a stable FluxRouter workload while diagnostics have no subscriber. */

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = process.env.FLUXFAST_BENCHMARK_REPOSITORY_ROOT
  ? path.resolve(process.env.FLUXFAST_BENCHMARK_REPOSITORY_ROOT)
  : path.resolve(scriptDirectory, "../..");
const requireFromRepository = createRequire(path.join(repositoryRoot, "package.json"));
const {
  FluxRouter,
  createFetchTransport,
} = requireFromRepository("./packages/core/dist/index.js");

function positiveInteger(value, option) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new TypeError(`${option} must be a positive integer`);
  }
  return parsed;
}

function parseArguments(argv) {
  const options = { iterations: 10_000, samples: 15 };
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === "--") continue;
    if (option !== "--iterations" && option !== "--samples") {
      throw new TypeError(`Unknown option: ${option}`);
    }
    options[option.slice(2)] = positiveInteger(argv[index + 1], option);
    index += 1;
  }
  return options;
}

function median(values) {
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 0
    ? (ordered[middle - 1] + ordered[middle]) / 2
    : ordered[middle];
}

let responseVersion = 0;

function responseUrl(input) {
  const value = typeof input === "string" || input instanceof URL
    ? String(input)
    : input.url;
  return new URL(value, "http://fluxfast.local").pathname;
}

async function benchmarkFetch(input) {
  responseVersion += 1;
  const url = responseUrl(input);
  return new Response(JSON.stringify({
    protocol: "fluxfast/1",
    page: { component: "benchmark/index", url },
    resourceKeys: ["summary"],
    resources: {
      summary: {
        version: `v${responseVersion}`,
        value: { count: responseVersion },
      },
    },
  }), {
    headers: { "Content-Type": "application/vnd.fluxfast+json" },
  });
}

async function measure(iterations) {
  const router = new FluxRouter({
    deferHistory: true,
    maxPages: 8,
    maxResources: 16,
    transport: createFetchTransport(),
  });
  assert.equal(router.diagnostics?.active ?? false, false);
  const started = performance.now();
  for (let index = 0; index < iterations; index += 1) {
    await router.visit(`/inactive/${index}`, {
      preserveState: true,
      usePrefetch: false,
    });
  }
  const durationMs = performance.now() - started;
  assert.equal(router.pageStore.getSnapshot().url, `/inactive/${iterations - 1}`);
  assert.equal(router.diagnostics?.active ?? false, false);
  router.destroy();
  return durationMs;
}

async function run({ iterations, samples }) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = benchmarkFetch;
  const samplesMs = [];
  try {
    await measure(Math.min(iterations, 250));
    for (let sample = 0; sample < samples; sample += 1) {
      samplesMs.push(await measure(iterations));
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
  const result = {
    iterations,
    medianMs: median(samplesMs),
    node: process.versions.node,
    repositoryRoot,
    samples,
    samplesMs,
  };
  console.log("FluxFast inactive-diagnostics runtime benchmark");
  console.log(
    `workload: ${samples} samples of ${iterations} uncached FluxRouter navigations through FetchTransport JSON parsing and protocol validation with no diagnostic subscriber`,
  );
  console.log(`median: ${result.medianMs.toFixed(3)} ms`);
  console.log(`inactive-diagnostics-result: ${JSON.stringify(result)}`);
  console.log(
    "correctness: PASS — every navigation converged and diagnostics remained inactive for the complete workload",
  );
}

await run(parseArguments(process.argv.slice(2)));
