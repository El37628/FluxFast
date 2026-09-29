import { describe, expect, it, vi } from "vitest";
import {
  FluxDiagnosticsHub,
  type FluxDiagnosticEvent,
} from "../src/diagnostics";

function diagnosticEvent(id: string): FluxDiagnosticEvent {
  return {
    id,
    timestamp: 1_700_000_000_000,
    type: "navigation",
    correlationId: "visit-1",
    data: { phase: "start" },
  };
}

describe("FluxDiagnosticsHub", () => {
  it("has an allocation-free inactive fast-path signal", () => {
    const hub = new FluxDiagnosticsHub();

    expect(hub.active).toBe(false);
    expect(() => hub.emit(diagnosticEvent("event-1"))).not.toThrow();
  });

  it("subscribes, emits to multiple listeners, and unsubscribes idempotently", () => {
    const hub = new FluxDiagnosticsHub();
    const first: FluxDiagnosticEvent[] = [];
    const second: FluxDiagnosticEvent[] = [];
    const stopFirst = hub.subscribe(event => first.push(event));
    const stopSecond = hub.subscribe(event => second.push(event));
    const event = diagnosticEvent("event-1");

    expect(hub.active).toBe(true);
    hub.emit(event);
    expect(first).toEqual([event]);
    expect(second).toEqual([event]);

    stopFirst();
    stopFirst();
    hub.emit(diagnosticEvent("event-2"));
    expect(first).toEqual([event]);
    expect(second.map(item => item.id)).toEqual(["event-1", "event-2"]);

    stopSecond();
    expect(hub.active).toBe(false);
  });

  it("isolates listener failures and continues notifying other subscribers", () => {
    const hub = new FluxDiagnosticsHub();
    const received: FluxDiagnosticEvent[] = [];
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    hub.subscribe(() => {
      throw new Error("diagnostic consumer failed");
    });
    hub.subscribe(event => received.push(event));
    const event = diagnosticEvent("event-1");

    expect(() => hub.emit(event)).not.toThrow();
    expect(received).toEqual([event]);
    expect(error).toHaveBeenCalledOnce();

    error.mockRestore();
  });

  it("uses a stable subscriber snapshot during reentrant cleanup", () => {
    const hub = new FluxDiagnosticsHub();
    const calls: string[] = [];
    let stopSecond = () => undefined;
    hub.subscribe(() => {
      calls.push("first");
      stopSecond();
    });
    stopSecond = hub.subscribe(() => calls.push("second"));

    hub.emit(diagnosticEvent("event-1"));
    hub.emit(diagnosticEvent("event-2"));

    expect(calls).toEqual(["first", "second", "first"]);
  });

  it("clears all diagnostic subscribers without retaining a timeline", () => {
    const hub = new FluxDiagnosticsHub();
    const listener = vi.fn();
    hub.subscribe(listener);

    hub.removeAllListeners();
    hub.emit(diagnosticEvent("event-1"));

    expect(hub.active).toBe(false);
    expect(listener).not.toHaveBeenCalled();
  });
});
