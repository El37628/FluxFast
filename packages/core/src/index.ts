/**
 * @fluxfast/core — Framework-neutral client runtime for FluxFast.
 */

/**
 * Application resource types supplied by generated module augmentation.
 *
 * This interface is intentionally empty in the published runtime. Generated
 * FluxFast type files merge their server-owned resource contracts into it.
 */
export interface FluxResourceMap {}

/** Logical resource keys registered by generated FluxFast types. */
export type FluxResourceKey = Extract<keyof FluxResourceMap, string>;

/** Resolve a registered resource value, falling back to unknown for dynamic keys. */
export type FluxResourceValue<Key extends string> =
  Key extends keyof FluxResourceMap ? FluxResourceMap[Key] : unknown;

export * from "./protocol";
export * from "./capabilities";
export * from "./live/protocol";
export { assertClientId, createClientId } from "./live/client-id";
export * from "./live/transport";
export * from "./live/manager";
export * from "./errors";
export * from "./events";
export * from "./mutation";
export * from "./store";
export * from "./cache";
export * from "./transport";
export * from "./history";
export * from "./prefetch";
export * from "./router";
export * from "./validation";
