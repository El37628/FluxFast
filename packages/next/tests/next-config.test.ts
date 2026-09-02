import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveFluxBackendUrl } from "../src/config";
import { generatePagesRegistry } from "../src/generate";
import { withFluxFast } from "../src/next-config";

vi.mock("../src/generate", () => ({
  generatePagesRegistry: vi.fn(),
}));

const originalBackendUrl = process.env.FLUXFAST_BACKEND_URL;
const originalProductionStart = process.env.FLUXFAST_PRODUCTION_START;
const originalNodeEnvironment = process.env.NODE_ENV;

afterEach(() => {
  vi.mocked(generatePagesRegistry).mockClear();
  if (originalBackendUrl === undefined) {
    delete process.env.FLUXFAST_BACKEND_URL;
  } else {
    process.env.FLUXFAST_BACKEND_URL = originalBackendUrl;
  }
  if (originalProductionStart === undefined) {
    delete process.env.FLUXFAST_PRODUCTION_START;
  } else {
    process.env.FLUXFAST_PRODUCTION_START = originalProductionStart;
  }
  if (originalNodeEnvironment === undefined) {
    delete process.env.NODE_ENV;
  } else {
    process.env.NODE_ENV = originalNodeEnvironment;
  }
});

describe("same-origin Next configuration", () => {
  it("uses the supervisor's server-only backend URL", () => {
    process.env.FLUXFAST_BACKEND_URL = "http://127.0.0.1:43123/";
    expect(resolveFluxBackendUrl()).toBe("http://127.0.0.1:43123");
  });

  it("does not generate files while the supervised production server starts", () => {
    process.env.FLUXFAST_PRODUCTION_START = "1";

    withFluxFast();

    expect(generatePagesRegistry).not.toHaveBeenCalled();
  });

  it("keeps registry generation enabled outside production startup", () => {
    delete process.env.FLUXFAST_PRODUCTION_START;

    withFluxFast();

    expect(generatePagesRegistry).toHaveBeenCalledOnce();
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

  it("uses the runtime transport route instead of baking a private production URL", async () => {
    process.env.NODE_ENV = "production";
    process.env.FLUXFAST_BACKEND_URL = "http://127.0.0.1:43123";
    const config = withFluxFast({}, { generate: false });

    const rewrites = await config.rewrites!();

    expect(Array.isArray(rewrites)).toBe(false);
    if (Array.isArray(rewrites)) throw new Error("Expected phased rewrites");
    expect(rewrites.beforeFiles[0]?.destination).toBe(
      "/_fluxfast/transport/:path*"
    );
  });

  it("preserves an explicitly configured static backend destination", async () => {
    process.env.NODE_ENV = "production";
    const config = withFluxFast(
      {},
      { generate: false, backendUrl: "http://backend.internal:8123" }
    );

    const rewrites = await config.rewrites!();

    expect(Array.isArray(rewrites)).toBe(false);
    if (Array.isArray(rewrites)) throw new Error("Expected phased rewrites");
    expect(rewrites.beforeFiles[0]?.destination).toBe(
      "http://backend.internal:8123/:path*"
    );
  });
});
