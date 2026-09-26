import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);

const readDoc = name =>
  fs.readFileSync(path.join(repositoryRoot, "docs", name), "utf8");

function markedBlock(document, marker) {
  const start = `<!-- ${marker}:start -->`;
  const end = `<!-- ${marker}:end -->`;
  assert.ok(document.includes(start), `missing ${start}`);
  assert.ok(document.includes(end), `missing ${end}`);
  return document.split(start, 2)[1].split(end, 1)[0];
}

function pythonInventory(classification) {
  const rows = [
    ...markedBlock(readDoc("python-api.md"), "python-api-export-table").matchAll(
      /^\| `([^`]+)` \| (Stable|Advanced Stable|Deprecated) \|/gm
    ),
  ];
  return rows
    .filter(match => match[2] === classification)
    .map(match => match[1]);
}

function textInventory(documentName, marker) {
  const block = markedBlock(readDoc(documentName), marker);
  const text = block.match(/```text\n([\s\S]*?)\n```/);
  assert.ok(text, `${marker} must contain a text inventory`);
  return text[1].trim().split("\n");
}

function exampleInventory(documentName, marker) {
  const block = markedBlock(readDoc(documentName), marker);
  const rows = [
    ...block.matchAll(/^\| `([^`]+)` \| `([^`]*)` \| (.+) \|$/gm),
  ];
  assert.ok(rows.length > 0, `${marker} must contain example rows`);
  for (const [, symbol, example, purpose] of rows) {
    assert.ok(example.trim(), `${symbol} must have a one-line example`);
    assert.ok(purpose.trim(), `${symbol} must explain its actual use`);
    assert.ok(!example.includes("\n"), `${symbol} example must remain one line`);
  }
  const names = rows.map(row => row[1]);
  assert.equal(
    new Set(names).size,
    names.length,
    `${marker} must not contain duplicate APIs`
  );
  return names;
}

const contracts = [
  {
    label: "Python Stable",
    expected: pythonInventory("Stable"),
    actual: exampleInventory("stable-apis.md", "stable-api-examples-python"),
  },
  {
    label: "Core Stable",
    expected: textInventory("core-api.md", "core-api-stable"),
    actual: exampleInventory("stable-apis.md", "stable-api-examples-core"),
  },
  {
    label: "Next Stable",
    expected: textInventory("next-api.md", "next-api-stable"),
    actual: exampleInventory("stable-apis.md", "stable-api-examples-next"),
  },
  {
    label: "Python Advanced Stable",
    expected: pythonInventory("Advanced Stable"),
    actual: exampleInventory(
      "advanced-stable-apis.md",
      "advanced-api-examples-python"
    ),
  },
  {
    label: "Core Advanced Stable",
    expected: textInventory("core-api.md", "core-api-advanced"),
    actual: exampleInventory(
      "advanced-stable-apis.md",
      "advanced-api-examples-core"
    ),
  },
  {
    label: "Next Advanced Stable",
    expected: textInventory("next-api.md", "next-api-advanced"),
    actual: exampleInventory(
      "advanced-stable-apis.md",
      "advanced-api-examples-next"
    ),
  },
];

for (const contract of contracts) {
  test(`${contract.label} APIs each have one declaration/use example`, () => {
    assert.deepEqual(contract.actual, contract.expected);
  });
}
