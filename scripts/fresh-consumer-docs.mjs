import path from "node:path";

export const FRESH_CONSUMER_FILES = Object.freeze([
  "backend/main.py",
  "frontend/src/flux-pages/about/index.tsx",
  "frontend/src/flux-pages/home/index.tsx",
]);

const FILE_BLOCK =
  /<!-- fresh-consumer:path=([^>\r\n]+) -->\r?\n```[A-Za-z0-9+-]*\r?\n([\s\S]*?)\r?\n```/g;

function assertSafeRelativePath(file) {
  const normalized = file.trim().replaceAll("\\", "/");
  if (
    !normalized ||
    normalized !== file ||
    path.posix.isAbsolute(normalized) ||
    normalized.split("/").some(segment => segment === "." || segment === "..") ||
    !/^[A-Za-z0-9._/-]+$/.test(normalized)
  ) {
    throw new TypeError(`Unsafe fresh-consumer documentation path: ${JSON.stringify(file)}`);
  }
  return normalized;
}

export function extractFreshConsumerFiles(markdown) {
  const files = new Map();
  for (const match of markdown.matchAll(FILE_BLOCK)) {
    const file = assertSafeRelativePath(match[1]);
    if (files.has(file)) {
      throw new TypeError(`Duplicate fresh-consumer documentation path: ${file}`);
    }
    files.set(file, `${match[2]}\n`);
  }

  const actual = [...files.keys()].toSorted();
  if (JSON.stringify(actual) !== JSON.stringify(FRESH_CONSUMER_FILES)) {
    throw new TypeError(
      `Fresh-consumer documentation files changed: expected ${FRESH_CONSUMER_FILES.join(", ")}; `
        + `received ${actual.join(", ") || "none"}`
    );
  }
  return files;
}
