import { createNextHarness } from "./next.mjs";
import { createReactHarness } from "./react.mjs";

export function createHarness(name = process.env.FLUXFAST_ADAPTER_HARNESS ?? "next", options = {}) {
  if (name === "next") return createNextHarness(options);
  if (name === "react") return createReactHarness(options);
  throw new Error(`Unknown adapter conformance harness: ${name}`);
}
