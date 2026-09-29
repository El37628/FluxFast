/** Compare inactive diagnostic overhead with the published v1.0.1 baseline. */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(script), "../..");
const TARGET_PERCENT = 1;

function median(values) {
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 0
    ? (ordered[middle - 1] + ordered[middle]) / 2
    : ordered[middle];
}

function relativeMad(values) {
  const center = median(values);
  if (center === 0) return 0;
  return median(values.map(value => Math.abs(value - center))) / center * 100;
}

export function evaluateInactiveComparison(pairs) {
  assert.equal(pairs.length, 2, "both workload orders are required");
  const comparisons = pairs.map(pair => {
    const baselineMedianMs = median(pair.baseline.samplesMs);
    const candidateMedianMs = median(pair.candidate.samplesMs);
    const regressionPercent = (candidateMedianMs / baselineMedianMs - 1) * 100;
    const noisePercent = Math.max(
      relativeMad(pair.baseline.samplesMs),
      relativeMad(pair.candidate.samplesMs),
    );
    return {
      order: pair.order,
      baselineMedianMs,
      candidateMedianMs,
      regressionPercent,
      noisePercent,
      lowerBoundPercent: regressionPercent - noisePercent,
    };
  });
  const blocked = comparisons.every(result => (
    result.regressionPercent > TARGET_PERCENT &&
    result.lowerBoundPercent > TARGET_PERCENT
  ));
  return { blocked, comparisons, targetPercent: TARGET_PERCENT };
}

function checked(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
    shell: false,
    timeout: 10 * 60_000,
    ...options,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, `${result.stdout ?? ""}${result.stderr ?? ""}`);
  return result.stdout ?? "";
}

function revision(root, reference = "HEAD") {
  return checked("git", ["-C", root, "rev-parse", `${reference}^{}`]).trim();
}

function benchmark(root, options) {
  const stdout = checked(process.execPath, [
    script.replace("compare_devtools_inactive.mjs", "benchmark_devtools_inactive.mjs"),
    "--samples",
    String(options.samples),
    "--iterations",
    String(options.iterations),
  ], {
    cwd: root,
    env: { ...process.env, FLUXFAST_BENCHMARK_REPOSITORY_ROOT: root },
  });
  const line = stdout.split(/\r?\n/).find(item =>
    item.startsWith("inactive-diagnostics-result: ")
  );
  assert.ok(line, `benchmark result missing for ${root}:\n${stdout}`);
  const result = JSON.parse(line.slice("inactive-diagnostics-result: ".length));
  assert.equal(result.samples, options.samples);
  assert.equal(result.iterations, options.iterations);
  return result;
}

function parseArguments(argv) {
  const options = { candidate: repositoryRoot, iterations: 10_000, samples: 15 };
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    assert.ok(
      ["--baseline", "--candidate", "--iterations", "--samples"].includes(option),
      `unknown option ${option}`,
    );
    const value = argv[++index];
    assert.ok(value && !value.startsWith("--"), `${option} needs a value`);
    if (option === "--baseline" || option === "--candidate") {
      options[option.slice(2)] = path.resolve(value);
    } else {
      const parsed = Number(value);
      assert.ok(Number.isSafeInteger(parsed) && parsed > 0, `${option} must be positive`);
      options[option.slice(2)] = parsed;
    }
  }
  assert.ok(options.baseline, "--baseline is required");
  return options;
}

export function runInactiveComparison(options) {
  assert.notEqual(
    revision(options.baseline),
    revision(options.candidate),
    "baseline and candidate must be different revisions",
  );
  assert.equal(
    revision(options.baseline),
    revision(options.candidate, "v1.0.1"),
    "baseline must be the published v1.0.1 tag",
  );
  const definitions = [
    ["baseline-candidate", ["baseline", "candidate"]],
    ["candidate-baseline", ["candidate", "baseline"]],
  ];
  const roots = { baseline: options.baseline, candidate: options.candidate };
  const pairs = definitions.map(([order, labels]) => {
    const results = {};
    for (const label of labels) {
      results[label] = benchmark(roots[label], options);
    }
    return { order, ...results };
  });
  const evaluation = evaluateInactiveComparison(pairs);
  console.log("FluxFast v1.0.1/candidate inactive-diagnostics comparison");
  console.log(
    `workload: both orders; ${options.samples} samples × ${options.iterations} uncached FetchTransport navigations per run`,
  );
  for (const result of evaluation.comparisons) {
    console.log(
      `${result.order}: baseline ${result.baselineMedianMs.toFixed(3)} ms; candidate ${result.candidateMedianMs.toFixed(3)} ms; difference ${result.regressionPercent.toFixed(3)}%; noise ${result.noisePercent.toFixed(3)}%; noise-adjusted ${result.lowerBoundPercent.toFixed(3)}%`,
    );
  }
  console.log(
    "policy: block only when both workload orders exceed 1% after subtracting their measured median absolute deviation; larger noise is treated as no measurable regression",
  );
  assert.equal(
    evaluation.blocked,
    false,
    "inactive diagnostics caused a repeatable noise-adjusted runtime regression above 1%",
  );
  console.log(
    "correctness: PASS — candidate inactive overhead stayed within the v1.0.1 target or the measured noise floor",
  );
  return evaluation;
}

if (process.argv[1] && path.resolve(process.argv[1]) === script) {
  runInactiveComparison(parseArguments(process.argv.slice(2)));
}
