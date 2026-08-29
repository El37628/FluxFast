/** Client capabilities advertised independently from the wire protocol version. */

export const HEADER_CAPABILITIES = "X-FluxFast-Capabilities";
export const CAPABILITY_DEFERRED_RESOURCES = "deferred-resources";

export const FLUX_CAPABILITIES = [CAPABILITY_DEFERRED_RESOURCES] as const;

export type FluxCapability = (typeof FLUX_CAPABILITIES)[number];

export function serializeCapabilities(): string {
  return FLUX_CAPABILITIES.join(",");
}
