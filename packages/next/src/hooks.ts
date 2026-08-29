"use client";

import { useSyncExternalStore, useCallback, useMemo } from "react";
import {
  FluxRouter,
  PageState,
  ResourceStateSnapshot,
} from "@fluxfast/core";
import { useFluxContext } from "./provider";

export function useRouter(): FluxRouter {
  return useFlux().router;
}

export function useFlux() {
  return useFluxContext();
}

export function usePage(): PageState {
  const router = useRouter();

  const subscribe = useCallback(
    (callback: () => void) => router.pageStore.subscribe(callback),
    [router]
  );

  const getSnapshot = useCallback(
    () => router.pageStore.getSnapshot(),
    [router]
  );

  return useSyncExternalStore(
    subscribe,
    getSnapshot,
    getSnapshot
  );
}

export function useResource<T = unknown>(key: string): T {
  const router = useRouter();

  const subscribe = useCallback(
    (callback: () => void) => router.resourceStore.subscribe(key, callback),
    [router, key]
  );

  const getSnapshot = useCallback(
    () => router.resourceStore.getSnapshot<T>(key),
    [router, key]
  );

  const getServerSnapshot = useCallback(
    () => router.resourceStore.getServerSnapshot<T>(key),
    [router, key]
  );

  const val = useSyncExternalStore(
    subscribe,
    getSnapshot,
    getServerSnapshot
  );

  return val as T;
}

/** Subscribe to stable status, error, data, and stale metadata for one resource. */
export function useResourceState<T = unknown>(
  key: string
): ResourceStateSnapshot<T> {
  const router = useRouter();

  const subscribe = useCallback(
    (callback: () => void) => router.resourceStore.subscribe(key, callback),
    [router, key]
  );
  const getSnapshot = useCallback(
    () => router.resourceStore.getStateSnapshot<T>(key),
    [router, key]
  );

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export interface DeferredResourceResult<T = unknown>
  extends ResourceStateSnapshot<T> {
  readonly retry: () => Promise<void>;
}

/** Read a deferred resource state and retry only that resource on demand. */
export function useDeferredResource<T = unknown>(
  key: string
): DeferredResourceResult<T> {
  const router = useRouter();
  const state = useResourceState<T>(key);
  const retry = useCallback(
    () => router.loadResources([key], { reason: "retry" }),
    [router, key]
  );

  return useMemo(
    () => ({ ...state, retry }),
    [state, retry]
  );
}
