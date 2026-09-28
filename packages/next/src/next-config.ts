/** Node-only Next.js configuration for same-origin FluxFast applications. */

import fs from "node:fs";
import path from "node:path";
import type { NextConfig } from "next";
import { resolveFluxBackendUrl } from "./config.js";
import { GenerateOptions, generatePagesRegistry } from "./generate.js";

export interface FluxFastNextOptions extends GenerateOptions {
  backendUrl?: string;
  generate?: boolean;
}

function hasRouteHandler(segment: string, ...routeSegments: string[]): boolean {
  const root = process.cwd();
  return ["ts", "js"].some(extension =>
    ["src", ""].some(sourceRoot =>
      fs.existsSync(
        path.join(
          root,
          sourceRoot,
          "app",
          segment,
          ...routeSegments,
          `route.${extension}`
        )
      )
    )
  );
}

function productionTransportPath(): string {
  const hasModernRoute = hasRouteHandler("fluxfast", "transport", "[[...path]]");
  const hasLegacyRoute = hasRouteHandler(
    "%5Ffluxfast",
    "transport",
    "[[...path]]"
  );
  return hasLegacyRoute && !hasModernRoute
    ? "/_fluxfast/transport/:path*"
    : "/fluxfast/transport/:path*";
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
          ? productionTransportPath()
          : `${backendUrl!}/:path*`,
      };
      const compatibilityHealth = {
        source: "/_fluxfast/:probe(healthz|readyz)",
        destination: "/fluxfast/:probe",
      };
      const usesLegacyHealth = hasRouteHandler("%5Ffluxfast", "[probe]") &&
        !hasRouteHandler("fluxfast", "[probe]");
      const beforeFiles = productionTransport &&
        proxy.destination.startsWith("/fluxfast/") &&
        !usesLegacyHealth
        ? [compatibilityHealth, proxy]
        : [proxy];

      if (Array.isArray(existing)) {
        return {
          beforeFiles,
          afterFiles: existing,
          fallback: [],
        };
      }
      return {
        beforeFiles: [...beforeFiles, ...(existing.beforeFiles ?? [])],
        afterFiles: existing.afterFiles ?? [],
        fallback: existing.fallback ?? [],
      };
    },
  };
}
