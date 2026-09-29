export type DevtoolsPanelName =
  | "overview"
  | "resources"
  | "timeline"
  | "cache"
  | "mutations"
  | "live"
  | "protocol";

export type DevtoolsTheme = "system" | "light" | "dark";
export type DevtoolsPosition = "bottom" | "right";

export const DEVTOOLS_PANELS: readonly DevtoolsPanelName[] = Object.freeze([
  "overview",
  "resources",
  "timeline",
  "cache",
  "mutations",
  "live",
  "protocol",
]);
export const DEVTOOLS_UI_STORAGE_KEY = "fluxfast:devtools:ui:v1";
export const MIN_PANEL_HEIGHT = 240;
export const DEFAULT_PANEL_HEIGHT = 420;
export const DEFAULT_SHORTCUT = "Alt+Shift+D";

export interface DevtoolsUiPreferences {
  readonly open: boolean;
  readonly panel: DevtoolsPanelName;
  readonly panelHeight: number;
  readonly theme: DevtoolsTheme;
  readonly position: DevtoolsPosition;
}

export interface DevtoolsShortcut {
  readonly key: string;
  readonly alt: boolean;
  readonly control: boolean;
  readonly meta: boolean;
  readonly shift: boolean;
}

interface PreferenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function resolveStorage(
  storage: PreferenceStorage | undefined
): PreferenceStorage | undefined {
  if (storage) return storage;
  if (typeof window === "undefined") return undefined;
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPanel(value: unknown): value is DevtoolsPanelName {
  return typeof value === "string" &&
    DEVTOOLS_PANELS.includes(value as DevtoolsPanelName);
}

function isTheme(value: unknown): value is DevtoolsTheme {
  return value === "system" || value === "light" || value === "dark";
}

function isPosition(value: unknown): value is DevtoolsPosition {
  return value === "bottom" || value === "right";
}

export function maximumPanelHeight(viewportHeight?: number): number {
  const height = viewportHeight ?? (
    typeof window === "undefined" ? 900 : window.innerHeight
  );
  return Math.max(
    MIN_PANEL_HEIGHT,
    Math.floor((Number.isFinite(height) && height > 0 ? height : 900) * 0.8)
  );
}

export function clampPanelHeight(
  value: number,
  viewportHeight?: number
): number {
  const maximum = maximumPanelHeight(viewportHeight);
  if (!Number.isFinite(value)) return Math.min(DEFAULT_PANEL_HEIGHT, maximum);
  return Math.min(maximum, Math.max(MIN_PANEL_HEIGHT, Math.round(value)));
}

export function defaultUiPreferences(options: {
  open: boolean;
  theme: DevtoolsTheme;
  position: DevtoolsPosition;
}): DevtoolsUiPreferences {
  return Object.freeze({
    open: options.open,
    panel: "overview",
    panelHeight: clampPanelHeight(DEFAULT_PANEL_HEIGHT),
    theme: isTheme(options.theme) ? options.theme : "system",
    position: isPosition(options.position) ? options.position : "bottom",
  });
}

export function readUiPreferences(
  defaults: DevtoolsUiPreferences,
  storage?: PreferenceStorage
): DevtoolsUiPreferences {
  const target = resolveStorage(storage);
  if (!target) return defaults;
  try {
    const serialized = target.getItem(DEVTOOLS_UI_STORAGE_KEY);
    if (serialized === null) return defaults;
    const parsed: unknown = JSON.parse(serialized);
    if (!isRecord(parsed)) return defaults;
    return Object.freeze({
      open: typeof parsed.open === "boolean" ? parsed.open : defaults.open,
      panel: isPanel(parsed.panel) ? parsed.panel : defaults.panel,
      panelHeight: typeof parsed.panelHeight === "number"
        ? clampPanelHeight(parsed.panelHeight)
        : defaults.panelHeight,
      theme: isTheme(parsed.theme) ? parsed.theme : defaults.theme,
      position: isPosition(parsed.position)
        ? parsed.position
        : defaults.position,
    });
  } catch {
    return defaults;
  }
}

export function writeUiPreferences(
  preferences: DevtoolsUiPreferences,
  storage?: PreferenceStorage
): void {
  const target = resolveStorage(storage);
  if (!target) return;
  try {
    target.setItem(DEVTOOLS_UI_STORAGE_KEY, JSON.stringify({
      open: preferences.open,
      panel: preferences.panel,
      panelHeight: clampPanelHeight(preferences.panelHeight),
      theme: preferences.theme,
      position: preferences.position,
    }));
  } catch {
    // UI persistence is optional and must never disable diagnostics.
  }
}

export function parseShortcut(value: string | false): DevtoolsShortcut | null {
  if (value === false || value.length === 0 || value.length > 64) return null;
  const parts = value.split("+").map(part => part.trim()).filter(Boolean);
  if (parts.length < 2) return null;
  const keyPart = parts.at(-1)!;
  if (keyPart.length === 0 || keyPart.length > 24) return null;
  const modifiers = new Set(parts.slice(0, -1).map(part => part.toLowerCase()));
  const allowed = new Set(["alt", "control", "ctrl", "meta", "shift"]);
  if ([...modifiers].some(part => !allowed.has(part))) return null;
  if (
    modifiers.size === 0 ||
    ["alt", "control", "ctrl", "meta", "shift"].includes(
      keyPart.toLowerCase()
    )
  ) {
    return null;
  }
  return Object.freeze({
    key: keyPart.toLowerCase(),
    alt: modifiers.has("alt"),
    control: modifiers.has("control") || modifiers.has("ctrl"),
    meta: modifiers.has("meta"),
    shift: modifiers.has("shift"),
  });
}

export function matchesShortcut(
  event: Pick<KeyboardEvent, "key" | "altKey" | "ctrlKey" | "metaKey" | "shiftKey">,
  shortcut: DevtoolsShortcut
): boolean {
  return event.key.toLowerCase() === shortcut.key &&
    event.altKey === shortcut.alt &&
    event.ctrlKey === shortcut.control &&
    event.metaKey === shortcut.meta &&
    event.shiftKey === shortcut.shift;
}
