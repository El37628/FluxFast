import path from "node:path";
import type { FluxCacheConfig } from "@fluxfast/react";
import { createFluxReactHandler } from "@fluxfast/react/server";
import type { ResolvedConfig } from "vite" with { "resolution-mode": "import" };

export interface FluxViteOptions {
  /** Source module exporting the same application for SSR and hydration. */
  application?: string;
  /** Named component export; generated registries use FluxApplication. */
  applicationExport?: string;
  /** Trusted HTML template relative to the frontend root. */
  template?: string;
  forwardHeaders?: readonly string[];
  cache?: FluxCacheConfig;
  timeoutMs?: number;
  /** Development diagnostics only; never enables production traces. */
  diagnostics?: boolean;
}

export interface FluxViteBuildOptions { root?: string; configFile?: string | false }

export interface HostSettings {
  forwardHeaders?: readonly string[];
  cache?: FluxCacheConfig;
  timeoutMs?: number;
}

export interface ResolvedFluxOptions {
  application: string;
  applicationExport: string;
  template: string;
  diagnostics: boolean;
  settings: HostSettings;
}

export const CLIENT_ENTRY = "/@fluxfast/client";
export const SERVER_ENTRY = "virtual:fluxfast/server";
export const CLIENT_ID = "\0fluxfast:client";
export const SERVER_ID = "\0fluxfast:server";
export const BUILD_DIRECTORY = "dist/fluxfast";

export function resolveOptions(root: string, options: FluxViteOptions): ResolvedFluxOptions {
  const application = options.application ?? "src/.fluxfast/pages.generated.ts";
  const applicationExport = options.applicationExport ?? "FluxApplication";
  const template = options.template ?? "fluxfast.html";
  if (typeof application !== "string" || !application || typeof template !== "string" || !template ||
      !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(applicationExport)) {
    throw new TypeError("FluxFast requires an application module, template, and valid export identifier");
  }
  if (options.diagnostics !== undefined && typeof options.diagnostics !== "boolean") {
    throw new TypeError("FluxFast diagnostics must be boolean");
  }
  if (options.forwardHeaders !== undefined && (!Array.isArray(options.forwardHeaders) || options.forwardHeaders.some(name => typeof name !== "string"))) {
    throw new TypeError("FluxFast forwardHeaders must be an array of header names");
  }
  // Reuse the SSR boundary's runtime validation without fetching or rendering.
  // Configuration failure should precede build output replacement/listening.
  createFluxReactHandler({ backendUrl: "http://fluxfast.invalid", render: async () => "", template: "",
    ...(options.cache === undefined ? {} : { cache: options.cache }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
  const templatePath = path.resolve(root, template);
  const relativeTemplate = path.relative(root, templatePath);
  if (!relativeTemplate || relativeTemplate.startsWith("..") || path.isAbsolute(relativeTemplate) || !/\.html?$/i.test(template)) {
    throw new TypeError("FluxFast template must be an HTML file inside the frontend root");
  }
  return {
    application: path.resolve(root, application).replace(/\\/g, "/"),
    applicationExport,
    template: templatePath,
    diagnostics: options.diagnostics === true,
    settings: {
      ...(options.forwardHeaders === undefined ? {} : { forwardHeaders: options.forwardHeaders }),
      ...(options.cache === undefined ? {} : { cache: options.cache }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    },
  };
}

/** Internal plugin metadata, not a separate consumer configuration API. */
export function configuredFluxOptions(config: ResolvedConfig): ResolvedFluxOptions {
  const plugins = config.plugins.filter(plugin => plugin.name === "fluxfast");
  const value = plugins.length === 1 ? plugins[0].api?.fluxfast : undefined;
  if (!value) throw new Error("Configure exactly one fluxfast() plugin in vite.config before building or serving");
  return value as ResolvedFluxOptions;
}

export function safeAssetName(name: string): boolean {
  return !name.startsWith("/") && !/[\\\x00-\x1f\x7f%?#]/.test(name) &&
    name.split("/").every(part => part.length > 0 && !part.startsWith(".")) &&
    !/\.(?:html?|map)$/i.test(name);
}
