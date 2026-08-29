"use client";

import { useSyncExternalStore, useCallback } from "react";
import { FluxRouter, PageState } from "@fluxfast/core";
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
