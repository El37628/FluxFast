/**
 * Mutation patch processing algorithms.
 */

import { ResourcePatch } from "./protocol";

function matchItem(item: unknown, patch: ResourcePatch): boolean {
  if (typeof item !== "object" || item === null) {
    return false;
  }
  const obj = item as Record<string, unknown>;

  if (patch.id !== undefined) {
    if (obj.id === patch.id || String(obj.id) === String(patch.id)) {
      return true;
    }
  }

  if (patch.match) {
    for (const [k, v] of Object.entries(patch.match)) {
      if (obj[k] !== v) {
        return false;
      }
    }
    return true;
  }

  return false;
}

export function applyPatchToValue(currentValue: unknown, patch: ResourcePatch): unknown {
  switch (patch.op) {
    case "replace-resource":
      return patch.value;

    case "merge-object": {
      if (typeof currentValue === "object" && currentValue !== null && !Array.isArray(currentValue)) {
        return {
          ...(currentValue as Record<string, unknown>),
          ...(typeof patch.value === "object" && patch.value !== null ? patch.value : {}),
        };
      }
      return patch.value;
    }

    case "replace-item": {
      if (Array.isArray(currentValue)) {
        return currentValue.map(item => (matchItem(item, patch) ? patch.value : item));
      }
      return currentValue;
    }

    case "remove-item": {
      if (Array.isArray(currentValue)) {
        return currentValue.filter(item => !matchItem(item, patch));
      }
      return currentValue;
    }

    case "append-item": {
      if (Array.isArray(currentValue)) {
        return [...currentValue, patch.value];
      }
      return [patch.value];
    }

    default:
      return currentValue;
  }
}

