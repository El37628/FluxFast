import { createNextHarness } from "./next.mjs";

export function createHarness(name = process.env.FLUXFAST_ADAPTER_HARNESS ?? "next", options = {}) {
  if (name === "next") return createNextHarness(options);
  throw new Error(`Unknown adapter conformance harness: ${name}`);
}
