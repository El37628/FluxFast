import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// Read identity and parentage, never command lines or unrelated environments.
export function processIdentity(pid, procRoot = "/proc") {
  try {
    const stat = fs.readFileSync(path.join(procRoot, String(pid), "stat"), "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
    const status = fs.readFileSync(path.join(procRoot, String(pid), "status"), "utf8");
    return { pid: Number(pid), parent: Number(fields[1]), born: fields[19],
      state: fields[0], rssKiB: Number(status.match(/^VmRSS:\s+(\d+)/m)?.[1] ?? 0) };
  } catch (error) {
    if (["ENOENT", "ESRCH", "EACCES"].includes(error.code)) return undefined;
    throw error;
  }
}

export function ownedProcesses(root, procRoot = "/proc") {
  const current = processIdentity(root.pid, procRoot);
  if (!current || current.born !== root.born) return [];
  const all = fs.readdirSync(procRoot).filter(name => /^\d+$/.test(name))
    .map(pid => processIdentity(pid, procRoot)).filter(Boolean);
  const selected = new Set([root.pid]);
  let changed;
  do {
    changed = false;
    for (const process of all) {
      if (selected.has(process.parent) && !selected.has(process.pid)) {
        selected.add(process.pid);
        changed = true;
      }
    }
  } while (changed);
  return all.filter(process => selected.has(process.pid));
}

export function snapshotInputs(consumer) {
  const result = {};
  // SQLite and build caches are runtime data, not immutable frontend inputs.
  const ignored = new Set([".next", "node_modules", "__pycache__", "playwright-report", "test-results"]);
  function visit(directory, relative = "") {
    for (const name of fs.readdirSync(directory).sort()) {
      if (ignored.has(name) || /\.sqlite3(?:-(?:wal|shm|journal))?$/.test(name) || name.endsWith(".tsbuildinfo")) continue;
      const absolute = path.join(directory, name);
      const target = relative ? `${relative}/${name}` : name;
      const stat = fs.lstatSync(absolute, { bigint: true });
      if (stat.isDirectory()) visit(absolute, target);
      else result[target] = { mode: String(stat.mode), mtimeNs: String(stat.mtimeNs),
        content: stat.isSymbolicLink() ? fs.readlinkSync(absolute)
          : crypto.createHash("sha256").update(fs.readFileSync(absolute)).digest("hex") };
    }
  }
  visit(consumer);
  return result;
}

export function positiveInteger(value, name, maximum) {
  assert.match(String(value), /^[1-9]\d*$/, `${name} must be a positive integer`);
  const parsed = Number(value);
  assert.ok(Number.isSafeInteger(parsed) && parsed <= maximum, `${name} must be <= ${maximum}`);
  return parsed;
}

export function outsideCheckout(consumer, repository) {
  const root = fs.realpathSync(consumer);
  const relative = path.relative(fs.realpathSync(repository), root);
  assert.ok(path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`),
    "the soak consumer must be outside the source checkout");
  return root;
}

export function observePageBody(method, request, response, status) {
  return method === "GET" && request["x-fluxfast"] === "1" && request["x-fluxfast-live"] !== "1"
    && !request["x-fluxfast-only"] && response["content-type"]?.includes("json")
    && status >= 200 && status < 300;
}

export function omittedKnownResources(envelope, encodedKnown) {
  if (!envelope.page || !encodedKnown) return 0;
  const known = JSON.parse(Buffer.from(encodedKnown, "base64url").toString("utf8"));
  return (envelope.resourceKeys ?? []).filter(key => Object.hasOwn(known, key)
    && !envelope.resources[key] && !envelope.errors?.[key] && !envelope.deferred?.includes(key)).length;
}

export function serverDiagnostics() {
  let pending = "";
  const lines = [];
  let truncated = false;
  function record(line) {
    if (/\b(?:WARNING|WARN|ERROR)\b|Traceback|DeprecationWarning|RuntimeWarning|Unhandled|ExceptionGroup/i.test(line)) {
      if (lines.length < 500) lines.push(line.slice(0, 10000));
      else truncated = true;
    }
  }
  return {
    write(chunk) {
      const parts = `${pending}${chunk}`.split(/\r?\n/);
      pending = parts.pop();
      for (const line of parts) record(line);
      if (pending.length > 10000) {
        record(pending);
        pending = "";
        truncated = true;
      }
    },
    finish() {
      if (pending) record(pending);
      pending = "";
      return { lines, truncated };
    },
  };
}
