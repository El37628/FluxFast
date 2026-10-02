"use client";

import { useCallback, useSyncExternalStore } from "react";
import type { LiveStatusSnapshot } from "@fluxfast/core";
import { useRouter } from "./hooks.js";

export type {
  LiveConnectionStatus,
  LiveStatusSnapshot,
} from "@fluxfast/core";

const SERVER_LIVE_STATUS: LiveStatusSnapshot = Object.freeze({
  status: "idle",
  connected: false,
  reconnectAttempt: 0,
  lastEventAt: null,
});

/** Observe the current Live Resource connection without affecting its lifecycle. */
export function useLiveStatus(): LiveStatusSnapshot {
  const router = useRouter();
  const subscribe = useCallback(
    (callback: () => void) => router.liveManager.subscribe(callback),
    [router]
  );
  const getSnapshot = useCallback(
    () => router.liveManager.getSnapshot(),
    [router]
  );

  return useSyncExternalStore(subscribe, getSnapshot, () => SERVER_LIVE_STATUS);
}
