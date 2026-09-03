import type { ProtocolVersion, ResourcePatch } from "../protocol.js";
import { PROTOCOL_VERSION } from "../protocol.js";
import { ProtocolError, VersionMismatchError } from "../errors.js";

export const LIVE_EVENT_NAME = "fluxfast" as const;

export const LIVE_RESYNC_REASONS = [
  "overflow",
  "reconnect",
  "broker-recovery",
  "server",
] as const;

export const MAX_LIVE_EVENT_KEYS = 100;
export const MAX_LIVE_RESOURCE_KEY_LENGTH = 128;
export const MAX_LIVE_CLIENT_ID_LENGTH = 64;

const LIVE_PATCH_OPERATIONS = new Set([
  "replace-resource",
  "merge-object",
  "replace-item",
  "remove-item",
  "append-item",
]);

export type LiveResyncReason = (typeof LIVE_RESYNC_REASONS)[number];

export interface LiveReadyEvent {
  protocol: ProtocolVersion;
  type: "ready";
  keys: string[];
}

export interface LiveInvalidateEvent {
  protocol: ProtocolVersion;
  type: "invalidate";
  keys: string[];
  originClientId?: string;
}

export interface LivePatchEvent {
  protocol: ProtocolVersion;
  type: "patch";
  patches: Record<string, ResourcePatch[]>;
  originClientId?: string;
}

export interface LiveResyncEvent {
  protocol: ProtocolVersion;
  type: "resync";
  keys: string[];
  reason: LiveResyncReason;
}

export type LiveEvent =
  | LiveReadyEvent
  | LiveInvalidateEvent
  | LivePatchEvent
  | LiveResyncEvent;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertResourceKeys(value: unknown): asserts value is string[] {
  if (!Array.isArray(value) || value.length > MAX_LIVE_EVENT_KEYS) {
    throw new ProtocolError(
      `Live event keys must be an array of at most ${MAX_LIVE_EVENT_KEYS} strings`
    );
  }
  for (const key of value) {
    if (
      typeof key !== "string" ||
      key.trim().length === 0 ||
      key.length > MAX_LIVE_RESOURCE_KEY_LENGTH ||
      key.includes(",") ||
      /[\u0000-\u001f]/.test(key)
    ) {
      throw new ProtocolError("Live event resource keys must be safe non-empty strings");
    }
  }
}

function assertOriginClientId(value: unknown): asserts value is string | undefined {
  if (value === undefined) return;
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_LIVE_CLIENT_ID_LENGTH ||
    !/^[\x21-\x7e]+$/.test(value)
  ) {
    throw new ProtocolError(
      `originClientId must be printable ASCII of at most ${MAX_LIVE_CLIENT_ID_LENGTH} characters`
    );
  }
}

function assertPatch(key: string, patch: unknown): asserts patch is ResourcePatch {
  if (!isObject(patch) || typeof patch.op !== "string") {
    throw new ProtocolError(`Invalid live patch for '${key}'`);
  }
  if (!LIVE_PATCH_OPERATIONS.has(patch.op)) {
    throw new ProtocolError(`Unsupported live patch operation for '${key}'`);
  }
  const hasIdentity =
    "id" in patch || (isObject(patch.match) && Object.keys(patch.match).length > 0);
  if (
    (["replace-resource", "merge-object", "append-item"].includes(patch.op) &&
      !("value" in patch)) ||
    (["replace-item", "remove-item"].includes(patch.op) && !hasIdentity) ||
    (patch.op === "replace-item" && !("value" in patch))
  ) {
    throw new ProtocolError(`Incomplete '${patch.op}' live patch for '${key}'`);
  }
}

/** Validate an untrusted decoded Live Resource wire event. */
export function assertLiveEvent(value: unknown): asserts value is LiveEvent {
  if (!isObject(value) || value.protocol !== PROTOCOL_VERSION) {
    const received = isObject(value) ? value.protocol : undefined;
    throw new VersionMismatchError(
      `Live protocol mismatch: expected '${PROTOCOL_VERSION}', got '${String(received)}'`
    );
  }

  if (value.type === "ready" || value.type === "invalidate") {
    assertResourceKeys(value.keys);
    if (value.type === "invalidate") assertOriginClientId(value.originClientId);
    return;
  }

  if (value.type === "patch") {
    if (!isObject(value.patches)) {
      throw new ProtocolError("Live patch event patches must be an object");
    }
    const keys = Object.keys(value.patches);
    assertResourceKeys(keys);
    for (const key of keys) {
      const patches = value.patches[key];
      if (!Array.isArray(patches)) {
        throw new ProtocolError(`Live patches for '${key}' must be an array`);
      }
      for (const patch of patches) assertPatch(key, patch);
    }
    assertOriginClientId(value.originClientId);
    return;
  }

  if (value.type === "resync") {
    assertResourceKeys(value.keys);
    if (
      typeof value.reason !== "string" ||
      !(LIVE_RESYNC_REASONS as readonly string[]).includes(value.reason)
    ) {
      throw new ProtocolError("Unknown live resync reason");
    }
    return;
  }

  throw new ProtocolError(`Unknown live event type '${String(value.type)}'`);
}
