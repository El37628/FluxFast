/** Measure generated-validator runtime without machine-dependent pass/fail thresholds. */

import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createValidator } = require("../../packages/core/dist/index.js");

function parseArguments(argv) {
  const options = { iterations: 25, samples: 5 };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") continue;
    if (argument !== "--samples" && argument !== "--iterations") {
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

function percentile(values, fraction) {
  const ordered = [...values].sort((left, right) => left - right);
  const index = Math.min(
    ordered.length - 1,
    Math.round((ordered.length - 1) * fraction),
  );
  return ordered[index];
}

function latencySummary(values, iterations) {
  const median = percentile(values, 0.5) / iterations;
  const p95 = percentile(values, 0.95) / iterations;
  return `${median.toFixed(3)} ms/validation median, ${p95.toFixed(3)} ms/validation p95`;
}

function measure(workload, samples, iterations) {
  workload.verify(workload.validator.validate(workload.value));
  const durations = [];
  for (let sample = 0; sample < samples; sample += 1) {
    const started = performance.now();
    let result;
    for (let iteration = 0; iteration < iterations; iteration += 1) {
      result = workload.validator.validate(workload.value);
    }
    durations.push(performance.now() - started);
    workload.verify(result);
  }
  return durations;
}

function nestedPlan(depth) {
  let plan = {
    kind: "object",
    properties: {
      id: { kind: "integer", minimum: 0 },
      label: { kind: "string", minLength: 1 },
    },
    required: ["id", "label"],
    additionalProperties: false,
  };
  for (let level = depth - 1; level >= 0; level -= 1) {
    plan = {
      kind: "object",
      properties: {
        child: plan,
        label: { kind: "string", minLength: 1 },
      },
      required: ["child", "label"],
      additionalProperties: false,
    };
  }
  return plan;
}

function nestedValue(depth, invalid = false) {
  let value = { id: 1, label: invalid ? "" : "leaf" };
  for (let level = depth - 1; level >= 0; level -= 1) {
    value = { child: value, label: `level-${level}` };
  }
  return value;
}

function recursiveValue(length, invalid = false) {
  let value;
  for (let index = length - 1; index >= 0; index -= 1) {
    value = {
      ...(value === undefined ? {} : { next: value }),
      value: invalid && index === length - 1 ? "invalid" : index,
    };
  }
  return value;
}

function pathOf(result) {
  assert.equal(result.valid, false);
  assert.ok(result.issues.length > 0);
  return result.issues[0].path;
}

function buildWorkloads() {
  const depth = 24;
  const arrayLength = 10_000;
  const recursiveLength = 16;
  const arrayPlan = {
    kind: "array",
    minItems: arrayLength,
    maxItems: arrayLength,
    items: {
      kind: "object",
      properties: {
        id: { kind: "integer", minimum: 0 },
        label: { kind: "string", minLength: 1 },
      },
      required: ["id", "label"],
      additionalProperties: false,
    },
  };
  const validArray = Array.from(
    { length: arrayLength },
    (_, index) => ({ id: index, label: `item-${index}` }),
  );
  const invalidArray = validArray.slice();
  invalidArray[arrayLength - 1] = { id: -1, label: "" };
  const recursivePlan = {
    root: { kind: "ref", name: "Node" },
    definitions: {
      Node: {
        kind: "object",
        properties: {
          next: {
            kind: "ref",
            name: "Node",
          },
          value: { kind: "integer" },
        },
        required: ["value"],
        additionalProperties: false,
      },
    },
  };

  return [
    {
      name: `large nested object (${depth} levels, valid)`,
      validator: createValidator(nestedPlan(depth)),
      value: nestedValue(depth),
      verify: result => assert.equal(result.valid, true),
    },
    {
      name: `large nested object (${depth} levels, invalid leaf)`,
      validator: createValidator(nestedPlan(depth)),
      value: nestedValue(depth, true),
      verify: result => assert.deepEqual(
        pathOf(result),
        [...Array(depth).fill("child"), "label"],
      ),
    },
    {
      name: `large array (${arrayLength} objects, valid)`,
      validator: createValidator(arrayPlan, { maxOperations: 500_000 }),
      value: validArray,
      verify: result => assert.equal(result.valid, true),
    },
    {
      name: `large array (${arrayLength} objects, invalid tail)`,
      validator: createValidator(arrayPlan, { maxOperations: 500_000 }),
      value: invalidArray,
      verify: result => {
        assert.equal(result.valid, false);
        assert.deepEqual(
          result.issues.map(issue => issue.path),
          [[arrayLength - 1, "id"], [arrayLength - 1, "label"]],
        );
      },
    },
    {
      name: `recursive linked value (${recursiveLength} nodes, valid)`,
      validator: createValidator(recursivePlan),
      value: recursiveValue(recursiveLength),
      verify: result => assert.equal(result.valid, true),
    },
    {
      name: `recursive linked value (${recursiveLength} nodes, invalid tail)`,
      validator: createValidator(recursivePlan),
      value: recursiveValue(recursiveLength, true),
      verify: result => {
        assert.equal(result.valid, false);
        assert.deepEqual(
          result.issues.at(-1)?.path,
          [...Array(recursiveLength - 1).fill("next"), "value"],
        );
      },
    },
  ];
}

function runBenchmark(samples, iterations) {
  const workloads = buildWorkloads();
  console.log("FluxFast controlled validator-runtime benchmark");
  console.log(`environment: Node ${process.versions.node}`);
  console.log(
    `workload: ${samples} measured samples of ${iterations} validations after one untimed correctness warm-up; no timing thresholds`,
  );
  for (const workload of workloads) {
    const durations = measure(workload, samples, iterations);
    console.log(
      `${workload.name}: ${latencySummary(durations, iterations)}`,
    );
  }
  console.log(
    "tradeoff: validation is synchronous and bounded; valid large collections traverse every element, while invalid-tail cases also retain exact nested issue paths",
  );
  console.log(
    "correctness: PASS — valid nested, array, and recursive values were accepted; invalid leaf and tail values were rejected at their exact paths",
  );
}

const { samples, iterations } = parseArguments(process.argv.slice(2));
runBenchmark(samples, iterations);
