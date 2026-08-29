import React from "react";
import { ComponentResolutionError } from "@fluxfast/core";

export type ComponentModule = { default: React.ComponentType<any> };
export interface LazyComponentEntry {
  load: () => Promise<ComponentModule>;
}
export type ComponentRegistryEntry = React.ComponentType<any> | LazyComponentEntry;
export type ComponentRegistry = Record<string, ComponentRegistryEntry>;

let globalRegistry: ComponentRegistry = {};
const lazyComponents = new WeakMap<LazyComponentEntry, React.LazyExoticComponent<React.ComponentType<any>>>();

export function setComponentRegistry(registry: ComponentRegistry): void {
  globalRegistry = registry;
}

export function getComponentRegistry(): ComponentRegistry {
  return globalRegistry;
}

function isLazyEntry(entry: ComponentRegistryEntry): entry is LazyComponentEntry {
  return typeof entry === "object" && entry !== null && "load" in entry;
}

export function resolveComponent(
  identifier: string,
  registry: ComponentRegistry = globalRegistry
): React.ComponentType<any> {
  const entry = registry[identifier];
  if (!entry) {
    const known = Object.keys(registry).sort().map(key => `- ${key}`).join("\n");
    throw new ComponentResolutionError(
      `FluxFast Component Resolution Error:\n\nComponent "${identifier}" was requested by the backend, but was not found in the component registry.\n\nRegistered components:\n${known || "(none)"}`
    );
  }

  if (!isLazyEntry(entry)) return entry;
  let component = lazyComponents.get(entry);
  if (!component) {
    component = React.lazy(entry.load);
    lazyComponents.set(entry, component);
  }
  return component;
}
