import React from "react";
import { renderToPipeableStream } from "react-dom/server";
import { Writable } from "node:stream";
import type { FluxApplicationProps } from "../config.js";
import { IDENTIFIER_PREFIX } from "../document.js";

export interface RenderFluxApplicationOptions {
  signal?: AbortSignal;
  /** Maximum time to resolve lazy modules and finish rendering; default 30s. */
  timeoutMs?: number;
}

export function validateRenderTimeout(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647) {
    throw new TypeError("FluxFast render timeoutMs must be a positive bounded integer");
  }
}

/** Render meaningful HTML, including lazy pages, without a client-only bailout. */
export function renderFluxApplication(
  application: React.ComponentType<FluxApplicationProps>,
  props: FluxApplicationProps,
  options: RenderFluxApplicationOptions = {},
): Promise<string> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  validateRenderTimeout(timeoutMs);
  if (options.signal !== undefined && (typeof options.signal?.aborted !== "boolean" ||
    typeof options.signal.addEventListener !== "function" || typeof options.signal.removeEventListener !== "function")) {
    throw new TypeError("FluxFast render signal must be an AbortSignal");
  }
  if (options.signal?.aborted) return Promise.reject(new Error("FluxFast rendering aborted"));

  return new Promise((resolve, reject) => {
    let settled = false;
    let stream: ReturnType<typeof renderToPipeableStream> | undefined;
    const chunks: Buffer[] = [];
    const destination = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        callback();
      },
    });
    const cleanup = () => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
      stream?.abort();
      destination.destroy();
    };
    const abort = () => fail(new Error("FluxFast rendering aborted"));
    const timer = setTimeout(() => fail(new Error("FluxFast rendering timed out")), timeoutMs);
    options.signal?.addEventListener("abort", abort, { once: true });
    destination.on("error", fail);
    destination.on("finish", () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    try {
      stream = renderToPipeableStream(React.createElement(application, props), {
        identifierPrefix: IDENTIFIER_PREFIX,
        // Lazy registry modules are part of the blocking page, not a deferred
        // resource. Waiting here avoids an empty fallback in the initial HTML.
        onAllReady() { if (!settled) stream!.pipe(destination); },
        onShellError: fail,
        onError: fail,
      });
    } catch (error) {
      fail(error);
    }
  });
}
