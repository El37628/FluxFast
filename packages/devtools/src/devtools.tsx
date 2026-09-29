"use client";

import React, {
  Component,
  type ErrorInfo,
  type ReactNode,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";
import { useFluxContext } from "@fluxfast/next";
import { DevtoolsStore, DEFAULT_MAX_EVENTS } from "./store.js";
import { DEVTOOLS_STYLES } from "./styles.js";

export interface FluxDevtoolsProps {
  position?: "bottom" | "right";
  theme?: "system" | "light" | "dark";
  defaultOpen?: boolean;
  maxEvents?: number;
  shortcut?: string | false;
}

interface BoundaryState {
  failed: boolean;
}

class DevtoolsErrorBoundary extends Component<
  { children: ReactNode },
  BoundaryState
> {
  override state: BoundaryState = { failed: false };

  static getDerivedStateFromError(): BoundaryState {
    return { failed: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("[fluxfast/devtools] DevTools disabled after an internal error", {
      name: error.name,
      componentStack: info.componentStack,
    });
  }

  override render(): ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}

function FluxDevtoolsInner({
  position = "bottom",
  theme = "system",
  defaultOpen = false,
  maxEvents = DEFAULT_MAX_EVENTS,
}: FluxDevtoolsProps) {
  const { router } = useFluxContext();
  const store = useMemo(
    () => new DevtoolsStore(router, maxEvents),
    [router, maxEvents]
  );
  const snapshot = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot
  );
  const [mountNode, setMountNode] = useState<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(defaultOpen);

  useEffect(() => store.start(), [store]);

  useEffect(() => {
    let host: HTMLDivElement | undefined;
    try {
      host = document.createElement("div");
      host.dataset.fluxfastDevtoolsHost = "";
      const shadow = host.attachShadow({ mode: "open" });
      const mount = document.createElement("div");
      shadow.append(mount);
      document.body.append(host);
      setMountNode(mount);
    } catch (error) {
      console.error("[fluxfast/devtools] Unable to create the isolated host", {
        name: error instanceof Error ? error.name : "UnknownError",
      });
    }

    return () => {
      setMountNode(null);
      host?.remove();
    };
  }, []);

  if (mountNode === null) return null;

  return createPortal(
    <>
      <style>{DEVTOOLS_STYLES}</style>
      <aside
        className={`ff-devtools ff-${position}`}
        data-theme={theme}
        aria-label="FluxFast DevTools"
      >
        {open && (
          <section
            id="fluxfast-devtools-panel"
            className="ff-panel"
            aria-label="FluxFast diagnostic summary"
          >
            <h2 className="ff-panel-title">FluxFast DevTools</h2>
            <p className="ff-panel-copy">
              Recording {snapshot.events.length} bounded diagnostic events.
            </p>
          </section>
        )}
        <button
          type="button"
          className="ff-bar"
          aria-expanded={open}
          aria-controls="fluxfast-devtools-panel"
          onClick={() => setOpen(value => !value)}
        >
          <span className="ff-brand">FluxFast</span>
          <span className="ff-route">{snapshot.page.url}</span>
          <span className="ff-count">
            {snapshot.resources.length} resources · {snapshot.events.length} events · {open ? "Close" : "Open"}
          </span>
        </button>
      </aside>
    </>,
    mountNode
  );
}

/** Mount the development-only FluxFast diagnostics UI. */
export function FluxDevtools(
  props: FluxDevtoolsProps
): React.ReactElement | null {
  if (process.env.NODE_ENV === "production") return null;
  return (
    <DevtoolsErrorBoundary>
      <FluxDevtoolsInner {...props} />
    </DevtoolsErrorBoundary>
  );
}
