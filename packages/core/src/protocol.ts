/**
 * Canonical TypeScript definitions for FluxFast wire protocol (fluxfast/1).
 * Framework-neutral, zero external runtime dependencies.
 */

export type ProtocolVersion = "fluxfast/1";

export const PROTOCOL_VERSION: ProtocolVersion = "fluxfast/1";
export const PROTOCOL_MEDIA_TYPE = "application/vnd.fluxfast+json";

export interface ResourceWireRecord<T = unknown> {
  version: string;
  value: T;
}

export interface PageDescriptor {
  component: string;
  url: string;
  meta?: Record<string, unknown>;
}

export interface ResourceErrorDetail {
  type: string;
  message: string;
  details?: unknown;
}

export interface PageEnvelope {
  protocol: ProtocolVersion;
  page: PageDescriptor;
  resources: Record<string, ResourceWireRecord>;
  resourceKeys?: string[];
  deferred?: string[];
  live?: string[];
  resourceErrors?: Record<string, ResourceErrorDetail>;
  appVersion?: string;
}

export type PatchOp =
  | "replace-resource"
  | "merge-object"
  | "replace-item"
  | "remove-item"
  | "append-item";

export interface ResourcePatch {
  op: PatchOp;
  id?: string | number;
  match?: Record<string, unknown>;
  value?: unknown;
}

export interface MutationPayload {
  patches?: Record<string, ResourcePatch[]>;
  invalidate?: string[];
  redirect?: string;
  externalRedirect?: string;
}

export interface MutationEnvelope {
  protocol: ProtocolVersion;
  mutation: MutationPayload;
}

export interface ErrorDetail {
  type: string;
  message: string;
  details?: unknown;
}

export interface ErrorEnvelope {
  protocol: ProtocolVersion;
  error: ErrorDetail;
}
