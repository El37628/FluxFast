import { describe, expect, it } from "vitest";
import {
  CAPABILITY_DEFERRED_RESOURCES,
  FLUX_CAPABILITIES,
  HEADER_CAPABILITIES,
  serializeCapabilities,
} from "../src/capabilities";

describe("FluxFast capabilities", () => {
  it("serializes the supported capabilities deterministically", () => {
    expect(CAPABILITY_DEFERRED_RESOURCES).toBe("deferred-resources");
    expect(HEADER_CAPABILITIES).toBe("X-FluxFast-Capabilities");
    expect(FLUX_CAPABILITIES).toEqual([CAPABILITY_DEFERRED_RESOURCES]);
    expect(serializeCapabilities()).toBe("deferred-resources");
  });
});
