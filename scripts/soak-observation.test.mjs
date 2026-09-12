import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { observePageBody, omittedKnownResources, ownedProcesses, outsideCheckout, positiveInteger, processIdentity, serverDiagnostics, snapshotInputs } from "./soak-observation.mjs";

test("owned process observations include only descendants and reject PID reuse", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fluxfast-proc-test-"));
  try {
    function record(pid, parent, born, name) {
      const directory = path.join(root, String(pid));
      fs.mkdirSync(directory);
      const fields = ["S", String(parent), ...Array(17).fill("0"), String(born)];
      fs.writeFileSync(path.join(directory, "stat"), `${pid} (${name}) ${fields.join(" ")}`);
      fs.writeFileSync(path.join(directory, "status"), "VmRSS:\t123 kB\n");
    }
    record(100, 1, 9, "supervisor (test)");
    record(101, 100, 10, "worker");
    record(102, 101, 11, "next");
    record(200, 1, 3, "unrelated");
    assert.equal(processIdentity(100, root).born, "9");
    assert.deepEqual(ownedProcesses({ pid: 100, born: "9" }, root).map(item => item.pid), [100, 101, 102]);
    assert.deepEqual(ownedProcesses({ pid: 100, born: "8" }, root), []);
    assert.equal(processIdentity(300, root), undefined);
  } finally {
    fs.rmSync(root, { recursive: true });
  }
});

test("source and generated input snapshot detects writes but excludes runtime data", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fluxfast-input-test-"));
  try {
    fs.mkdirSync(path.join(root, "src", ".fluxfast"), { recursive: true });
    fs.mkdirSync(path.join(root, ".next"));
    fs.writeFileSync(path.join(root, "src", ".fluxfast", "types.generated.ts"), "export type Example = string;");
    const before = snapshotInputs(root);
    fs.writeFileSync(path.join(root, "board.sqlite3"), "runtime");
    fs.writeFileSync(path.join(root, ".next", "cache"), "runtime");
    assert.deepEqual(snapshotInputs(root), before);
    fs.writeFileSync(path.join(root, "src", ".fluxfast", "types.generated.ts"), "export type Example = number;");
    assert.notDeepEqual(snapshotInputs(root), before);
    assert.throws(() => outsideCheckout(root, root), /outside/);
    assert.equal(outsideCheckout(root, path.join(root, "src")), root);
  } finally {
    fs.rmSync(root, { recursive: true });
  }
});

test("soak counts cannot silently truncate, become zero, or exceed the explicit bound", () => {
  assert.equal(positiveInteger("200", "cycles", 1000), 200);
  for (const input of [0, -1, "1.5", "2oops", "1e2", 1001]) {
    assert.throws(() => positiveInteger(input, "cycles", 1000));
  }
});

test("page observer never waits on session POSTs, mutations, live streams or partial loads", () => {
  const request = { "x-fluxfast": "1" };
  const response = { "content-type": "application/vnd.fluxfast+json" };
  assert.equal(observePageBody("GET", request, response, 200), true);
  assert.equal(observePageBody("POST", request, response, 200), false);
  assert.equal(observePageBody("GET", { ...request, "x-fluxfast-live": "1" }, response, 200), false);
  assert.equal(observePageBody("GET", { ...request, "x-fluxfast-only": "summary" }, response, 200), false);
  assert.equal(observePageBody("GET", request, { "content-type": "text/event-stream" }, 200), false);
  assert.equal(observePageBody("GET", request, response, 404), false);
  assert.equal(observePageBody("GET", {}, response, 200), false);
});

test("omission evidence counts only known ready resources, not deferred, failed, or undeclared values", () => {
  const known = Buffer.from(JSON.stringify({ viewer: "v1", summary: "v2", failed: "v3" })).toString("base64url");
  const envelope = { protocol: "fluxfast/1", page: { component: "home/index", url: "/" },
    resourceKeys: ["viewer", "summary", "failed", "unknown", "sent"], resources: { sent: { version: "v4", value: 1 } },
    deferred: ["summary"], errors: { failed: { message: "load failed" } } };
  assert.equal(omittedKnownResources(envelope, known), 1);
  assert.equal(omittedKnownResources(envelope, undefined), 0);
  assert.equal(omittedKnownResources({ mutation: {} }, known), 0);
});

test("server warning observer retains split and unterminated lines and reports bounded truncation", () => {
  const observer = serverDiagnostics();
  observer.write("INFO: ready\nWARN");
  observer.write("ING: first\nDeprecationWarning: second");
  assert.deepEqual(observer.finish(), { lines: ["WARNING: first", "DeprecationWarning: second"], truncated: false });
  assert.equal(observer.finish().lines.length, 2);
  const flood = serverDiagnostics();
  flood.write("ERROR: failure\n".repeat(501));
  assert.equal(flood.finish().lines.length, 500);
  assert.equal(flood.finish().truncated, true);
});
