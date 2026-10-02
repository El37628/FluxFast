import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { createReadStream } from "node:fs";
import { safeAssetName } from "./options.js";

const CONTENT_TYPES: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".ico": "image/x-icon", ".woff": "font/woff", ".woff2": "font/woff2",
};

export interface BuiltHostManifest { version: 1; template: string; assets: string[] }

export function readHostManifest(value: unknown): BuiltHostManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid FluxFast production manifest");
  const data = value as Record<string, unknown>;
  if (data.version !== 1 || typeof data.template !== "string" || !safeAssetName(data.template.replace(/\.html?$/i, ".template")) ||
      !/\.html?$/i.test(data.template) || !Array.isArray(data.assets) ||
      data.assets.some(name => typeof name !== "string" || !safeAssetName(name)) ||
      new Set(data.assets).size !== data.assets.length) throw new Error("Invalid FluxFast production manifest");
  return { version: 1, template: data.template, assets: data.assets as string[] };
}

export async function containedFile(root: string, name: string): Promise<string> {
  const realRoot = await fs.realpath(root);
  const candidate = await fs.realpath(path.join(root, name));
  const relative = path.relative(realRoot, candidate);
  if (!relative || relative.startsWith(".." + path.sep) || relative === ".." || path.isAbsolute(relative) ||
      !(await fs.stat(candidate)).isFile()) throw new Error("FluxFast output is not a contained regular file");
  return candidate;
}

export function createAssetHandler(root: string, names: readonly string[], templateName = "fluxfast.html"): (request: Request) => Promise<Response | undefined> {
  const assets = new Set(names);
  return async request => {
    const pathname = new URL(request.url).pathname;
    let name: string;
    try { name = decodeURIComponent(pathname.slice(1)); } catch { return new Response(null, { status: 400 }); }
    if (!assets.has(name)) {
      // Reserved tooling/output paths and missing assets cannot become a SPA
      // fallback or expose the raw SSR template, source or renderer.
      if (name === templateName || /^\/(?:assets(?:\/|$)|@|src(?:\/|$)|node_modules(?:\/|$)|dist(?:\/|$)|\.)(?:.*)$/.test("/" + name)) {
        return new Response(null, { status: 404, headers: { "cache-control": "no-store" } });
      }
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 405, headers: { allow: "GET, HEAD" } });
    try {
      const file = await containedFile(root, name);
      const headers = { "content-type": CONTENT_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream", "cache-control": "public, max-age=0, must-revalidate", "x-content-type-options": "nosniff" };
      if (request.method === "HEAD") return new Response(null, { headers });
      const stream = createReadStream(file);
      return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, { headers });
    } catch { return new Response(null, { status: 404, headers: { "cache-control": "no-store" } }); }
  };
}
