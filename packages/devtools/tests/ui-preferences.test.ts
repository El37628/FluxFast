import { describe, expect, it } from "vitest";
import {
  clampPanelHeight,
  DEFAULT_SHORTCUT,
  defaultUiPreferences,
  DEVTOOLS_UI_STORAGE_KEY,
  matchesShortcut,
  maximumPanelHeight,
  parseShortcut,
  readUiPreferences,
  writeUiPreferences,
} from "../src/ui-preferences";

function memoryStorage(initial?: string) {
  let value = initial ?? null;
  return {
    getItem: (key: string) => key === DEVTOOLS_UI_STORAGE_KEY ? value : null,
    setItem: (key: string, next: string) => {
      if (key === DEVTOOLS_UI_STORAGE_KEY) value = next;
    },
    value: () => value,
  };
}

describe("DevTools UI preferences", () => {
  it("validates persisted UI-only settings and clamps panel height", () => {
    const defaults = defaultUiPreferences({
      open: false,
      theme: "system",
      position: "bottom",
    });
    const storage = memoryStorage(JSON.stringify({
      open: true,
      panel: "protocol",
      panelHeight: 300,
      theme: "dark",
      position: "right",
      events: ["must-not-be-restored"],
    }));

    expect(readUiPreferences(defaults, storage)).toEqual({
      open: true,
      panel: "protocol",
      panelHeight: 300,
      theme: "dark",
      position: "right",
    });
    expect(maximumPanelHeight(1_000)).toBe(800);
    expect(clampPanelHeight(100, 1_000)).toBe(240);
    expect(clampPanelHeight(900, 1_000)).toBe(800);
  });

  it("falls back safely and persists no diagnostic history", () => {
    const defaults = defaultUiPreferences({
      open: false,
      theme: "light",
      position: "bottom",
    });
    expect(readUiPreferences(defaults, memoryStorage("not-json"))).toBe(defaults);
    expect(readUiPreferences(defaults, {
      getItem: () => { throw new Error("storage disabled"); },
      setItem: () => undefined,
    })).toBe(defaults);

    const storage = memoryStorage();
    writeUiPreferences({
      open: true,
      panel: "timeline",
      panelHeight: 320,
      theme: "dark",
      position: "right",
    }, storage);
    expect(JSON.parse(storage.value()!)).toEqual({
      open: true,
      panel: "timeline",
      panelHeight: 320,
      theme: "dark",
      position: "right",
    });
  });
});

describe("DevTools shortcut", () => {
  it("matches the default shortcut with exact modifiers", () => {
    const shortcut = parseShortcut(DEFAULT_SHORTCUT)!;
    expect(matchesShortcut({
      key: "d",
      altKey: true,
      ctrlKey: false,
      metaKey: false,
      shiftKey: true,
    }, shortcut)).toBe(true);
    expect(matchesShortcut({
      key: "d",
      altKey: true,
      ctrlKey: true,
      metaKey: false,
      shiftKey: true,
    }, shortcut)).toBe(false);
  });

  it("rejects disabled, modifier-free, and malformed shortcuts", () => {
    expect(parseShortcut(false)).toBeNull();
    expect(parseShortcut("D")).toBeNull();
    expect(parseShortcut("Alt+Hyper+D")).toBeNull();
    expect(parseShortcut("Alt+Shift")).toBeNull();
  });
});
