/** Node-only Next.js configuration for same-origin FluxFast applications. */

import type { NextConfig } from "next";
import { resolveFluxBackendUrl } from "./config";
import { GenerateOptions, generatePagesRegistry } from "./generate";

export interface FluxFastNextOptions extends GenerateOptions {
  backendUrl?: string;
  generate?: boolean;
}

/**
 * Add registry generation and a header-gated backend proxy to a Next config.
 * Normal document requests still resolve through the Next catch-all page;
 * only requests marked by the FluxFast transport reach FastAPI.
 */
export function withFluxFast(
  nextConfig: NextConfig = {},
  options: FluxFastNextOptions = {}
): NextConfig {
  const immutableProductionStart =
    process.env.FLUXFAST_PRODUCTION_START === "1";
  if (options.generate !== false && !immutableProductionStart) {
    generatePagesRegistry({
      pagesDir: options.pagesDir,
      outputFile: options.outputFile,
    });
  }

  const configuredRewrites = nextConfig.rewrites;

  return {
    ...nextConfig,
    async rewrites() {
      const existing = configuredRewrites
        ? await configuredRewrites.call(nextConfig)
        : [];
      const productionTransport =
        options.backendUrl === undefined && process.env.NODE_ENV === "production";
      const backendUrl = productionTransport
        ? undefined
        : resolveFluxBackendUrl(options.backendUrl);
      const proxy = {
        source: "/:path*",
        has: [
          {
            type: "header" as const,
            key: "x-fluxfast",
            value: "1",
          },
        ],
        destination: productionTransport
          ? "/_fluxfast/transport/:path*"
          : `${backendUrl!}/:path*`,
      };

      if (Array.isArray(existing)) {
        return {
          beforeFiles: [proxy],
          afterFiles: existing,
          fallback: [],
        };
      }
      return {
        beforeFiles: [proxy, ...(existing.beforeFiles ?? [])],
        afterFiles: existing.afterFiles ?? [],
        fallback: existing.fallback ?? [],
      };
    },
  };
}
