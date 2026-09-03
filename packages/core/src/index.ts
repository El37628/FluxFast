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

export * from "./protocol.js";
export * from "./capabilities.js";
export * from "./live/protocol.js";
export { assertClientId, createClientId } from "./live/client-id.js";
export * from "./live/transport.js";
export * from "./live/manager.js";
export * from "./errors.js";
export * from "./events.js";
export * from "./mutation.js";
export * from "./store.js";
export * from "./cache.js";
export * from "./transport.js";
export * from "./history.js";
export * from "./prefetch.js";
export * from "./router.js";
export * from "./validation/index.js";
