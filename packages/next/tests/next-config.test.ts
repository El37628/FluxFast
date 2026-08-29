import { afterEach, describe, expect, it } from "vitest";
import { resolveFluxBackendUrl } from "../src/config";
import { withFluxFast } from "../src/next-config";

const originalBackendUrl = process.env.FLUXFAST_BACKEND_URL;

afterEach(() => {
  if (originalBackendUrl === undefined) {
    delete process.env.FLUXFAST_BACKEND_URL;
  } else {
    process.env.FLUXFAST_BACKEND_URL = originalBackendUrl;
  }
});

describe("same-origin Next configuration", () => {
  it("uses the supervisor's server-only backend URL", () => {
    process.env.FLUXFAST_BACKEND_URL = "http://127.0.0.1:43123/";
    expect(resolveFluxBackendUrl()).toBe("http://127.0.0.1:43123");
  });

  it("adds a header-gated proxy before application routes", async () => {
    process.env.FLUXFAST_BACKEND_URL = "http://127.0.0.1:43123";
    const config = withFluxFast(
      {
        rewrites: async () => [
          { source: "/legacy", destination: "/dashboard" },
        ],
      },
      { generate: false }
    );

    const rewrites = await config.rewrites!();
    expect(Array.isArray(rewrites)).toBe(false);
    if (Array.isArray(rewrites)) throw new Error("Expected phased rewrites");
    expect(rewrites.beforeFiles).toEqual([
      {
        source: "/:path*",
        has: [{ type: "header", key: "x-fluxfast", value: "1" }],
        destination: "http://127.0.0.1:43123/:path*",
      },
    ]);
    expect(rewrites.afterFiles).toEqual([
      { source: "/legacy", destination: "/dashboard" },
    ]);
  });
});
