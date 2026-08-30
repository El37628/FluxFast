/** Framework-neutral fetch-based SSE transport for Live Resources. */

import { HEADER_CAPABILITIES, serializeCapabilities } from "../capabilities";
import { ProtocolError, TransportError } from "../errors";
import {
  assertLiveEvent,
  LIVE_EVENT_NAME,
  LiveEvent,
  MAX_LIVE_CLIENT_ID_LENGTH,
  MAX_LIVE_EVENT_KEYS,
  MAX_LIVE_RESOURCE_KEY_LENGTH,
} from "./protocol";

export const HEADER_LIVE = "X-FluxFast-Live";
export const HEADER_LIVE_KEYS = "X-FluxFast-Live-Keys";
export const HEADER_CLIENT_ID = "X-FluxFast-Client-ID";
export const MAX_LIVE_KEYS_HEADER_BYTES = 16 * 1024;
export const MAX_LIVE_EVENT_BYTES = 1024 * 1024;

export interface LiveConnectionOptions {
  url: string;
  keys: string[];
  clientId?: string;
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

export interface LiveConnection extends AsyncIterable<LiveEvent> {
  readonly signal: AbortSignal;
  close(reason?: unknown): void;
}

export interface LiveTransport {
  connect(options: LiveConnectionOptions): LiveConnection;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function serializeLiveKeys(keys: string[]): string {
  if (!Array.isArray(keys) || keys.length === 0) {
    throw new ProtocolError("A live connection requires at least one resource key");
  }
  const normalized = [...new Set(keys)].sort();
  if (normalized.length > MAX_LIVE_EVENT_KEYS) {
    throw new ProtocolError(
      `A live connection may contain at most ${MAX_LIVE_EVENT_KEYS} resource keys`
    );
  }
  for (const key of normalized) {
    if (
      typeof key !== "string" ||
      key.trim().length === 0 ||
      key.length > MAX_LIVE_RESOURCE_KEY_LENGTH ||
      key.includes(",") ||
      /[\u0000-\u001f]/.test(key)
    ) {
      throw new ProtocolError("Live resource keys must be safe non-empty strings");
    }
  }
  const serialized = normalized.join(",");
  if (new TextEncoder().encode(serialized).byteLength > MAX_LIVE_KEYS_HEADER_BYTES) {
    throw new ProtocolError(
      `Live resource key metadata exceeds ${MAX_LIVE_KEYS_HEADER_BYTES} bytes`
    );
  }
  return serialized;
}

function assertClientId(clientId: string | undefined): void {
  if (clientId === undefined) return;
  if (
    typeof clientId !== "string" ||
    clientId.length === 0 ||
    clientId.length > MAX_LIVE_CLIENT_ID_LENGTH ||
    !/^[\x21-\x7e]+$/.test(clientId)
  ) {
    throw new ProtocolError(
      `Live client ID must be printable ASCII of at most ${MAX_LIVE_CLIENT_ID_LENGTH} characters`
    );
  }
}

function parseFrame(frame: string): LiveEvent | undefined {
  let eventName: string | undefined;
  const data: string[] = [];
  for (const line of frame.split(/\r\n|\r|\n/)) {
    if (line.length === 0 || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") eventName = value;
    if (field === "data") data.push(value);
  }

  if (eventName === undefined && data.length === 0) return undefined;
  if (eventName !== LIVE_EVENT_NAME) {
    throw new ProtocolError(`Unknown SSE event '${String(eventName)}'`);
  }
  if (data.length === 0) {
    throw new ProtocolError("FluxFast SSE event is missing data");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(data.join("\n"));
  } catch {
    throw new ProtocolError("FluxFast SSE event contains malformed JSON");
  }
  assertLiveEvent(parsed);
  return parsed;
}

/** Incrementally parse arbitrarily chunked SSE bytes into validated live events. */
export class FluxSseParser {
  private readonly decoder = new TextDecoder();
  private buffer = "";

  push(chunk: Uint8Array): LiveEvent[] {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    return this.drain(false);
  }

  finish(): LiveEvent[] {
    this.buffer += this.decoder.decode();
    return this.drain(true);
  }

  private drain(finish: boolean): LiveEvent[] {
    const events: LiveEvent[] = [];
    while (true) {
      const separator = /\r\n\r\n|\n\n|\r\r/.exec(this.buffer);
      if (!separator || separator.index === undefined) break;
      const frame = this.buffer.slice(0, separator.index);
      this.buffer = this.buffer.slice(separator.index + separator[0].length);
      this.assertFrameSize(frame);
      const event = parseFrame(frame);
      if (event) events.push(event);
    }

    if (finish && this.buffer.length > 0) {
      const frame = this.buffer;
      this.buffer = "";
      this.assertFrameSize(frame);
      const event = parseFrame(frame);
      if (event) events.push(event);
    }
    this.assertFrameSize(this.buffer);
    return events;
  }

  private assertFrameSize(frame: string): void {
    if (new TextEncoder().encode(frame).byteLength > MAX_LIVE_EVENT_BYTES) {
      throw new ProtocolError(
        `FluxFast SSE event exceeds ${MAX_LIVE_EVENT_BYTES} bytes`
      );
    }
  }
}

class FetchSseLiveConnection implements LiveConnection {
  private readonly controller = new AbortController();
  private readonly externalSignal?: AbortSignal;
  private readonly externalAbort: () => void;
  private reader?: ReadableStreamDefaultReader<Uint8Array>;
  private started = false;

  constructor(
    private readonly url: string,
    private readonly headers: Record<string, string>,
    signal?: AbortSignal
  ) {
    this.externalSignal = signal;
    this.externalAbort = () => this.close(signal?.reason);
    if (signal?.aborted) {
      this.controller.abort(signal.reason);
    } else {
      signal?.addEventListener("abort", this.externalAbort, { once: true });
    }
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  close(reason?: unknown): void {
    this.externalSignal?.removeEventListener("abort", this.externalAbort);
    if (!this.controller.signal.aborted) this.controller.abort(reason);
    void this.reader?.cancel(reason).catch(() => undefined);
  }

  async *[Symbol.asyncIterator](): AsyncIterator<LiveEvent> {
    if (this.started) {
      throw new ProtocolError("A live connection can only be consumed once");
    }
    this.started = true;
    if (this.signal.aborted) return;

    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await fetch(this.url, {
        method: "GET",
        headers: this.headers,
        signal: this.signal,
        credentials: "include",
      });
      if (!response.ok) {
        let details: unknown;
        try {
          details = await response.json();
        } catch {
          details = undefined;
        }
        const message =
          isObject(details) &&
          isObject(details.error) &&
          typeof details.error.message === "string"
            ? details.error.message
            : `Live connection failed with HTTP status ${response.status}`;
        throw new TransportError(message, response.status, details);
      }

      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.toLowerCase().includes("text/event-stream")) {
        throw new ProtocolError(
          `Expected a text/event-stream response, got '${contentType || "missing"}'`
        );
      }
      if (!response.body) {
        throw new ProtocolError("Live response has no readable body");
      }

      reader = response.body.getReader();
      this.reader = reader;
      const parser = new FluxSseParser();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const event of parser.push(value)) yield event;
      }
      for (const event of parser.finish()) yield event;
    } finally {
      this.reader = undefined;
      if (reader) {
        try {
          await reader.cancel();
        } catch {
          // The abort path may already have cancelled the reader.
        }
      }
      this.close();
    }
  }
}

export class FetchSseLiveTransport implements LiveTransport {
  private readonly baseUrl: string;

  constructor(baseUrl: string = "") {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  connect(options: LiveConnectionOptions): LiveConnection {
    const keys = serializeLiveKeys(options.keys);
    assertClientId(options.clientId);
    const headers: Record<string, string> = {
      ...(options.headers ?? {}),
      Accept: "text/event-stream",
      "X-FluxFast": "1",
      "X-FluxFast-Protocol": "1",
      [HEADER_LIVE]: "1",
      [HEADER_LIVE_KEYS]: keys,
      [HEADER_CAPABILITIES]: serializeCapabilities(),
    };
    if (options.clientId) headers[HEADER_CLIENT_ID] = options.clientId;
    return new FetchSseLiveConnection(
      this.resolveUrl(options.url),
      headers,
      options.signal
    );
  }

  private resolveUrl(path: string): string {
    if (/^https?:\/\//i.test(path)) return path;
    return `${this.baseUrl}${path.startsWith("/") ? "" : "/"}${path}`;
  }
}

export function createFetchSseLiveTransport(baseUrl: string = ""): FetchSseLiveTransport {
  return new FetchSseLiveTransport(baseUrl);
}
