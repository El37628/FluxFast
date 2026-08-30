import type { ProtocolVersion, ResourcePatch } from "../protocol";

export const LIVE_EVENT_NAME = "fluxfast" as const;

export const LIVE_RESYNC_REASONS = [
  "overflow",
  "reconnect",
  "broker-recovery",
  "server",
] as const;

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
