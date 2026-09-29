export const DEVTOOLS_STYLES: string = `
:host {
  all: initial;
  color-scheme: light dark;
}

*, *::before, *::after {
  box-sizing: border-box;
}

.ff-devtools {
  --ff-bg: #f8fafc;
  --ff-panel: #ffffff;
  --ff-text: #172033;
  --ff-muted: #64748b;
  --ff-border: #cbd5e1;
  --ff-primary: #2563eb;
  position: fixed;
  z-index: 2147483000;
  color: var(--ff-text);
  font: 500 12px/1.4 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}

.ff-devtools[data-theme="dark"] {
  --ff-bg: #080d18;
  --ff-panel: #0f172a;
  --ff-text: #e2e8f0;
  --ff-muted: #94a3b8;
  --ff-border: #334155;
  --ff-primary: #60a5fa;
  color-scheme: dark;
}

.ff-devtools[data-theme="system"] {
  color-scheme: light dark;
}

@media (prefers-color-scheme: dark) {
  .ff-devtools[data-theme="system"] {
    --ff-bg: #080d18;
    --ff-panel: #0f172a;
    --ff-text: #e2e8f0;
    --ff-muted: #94a3b8;
    --ff-border: #334155;
    --ff-primary: #60a5fa;
  }
}

.ff-bottom {
  right: 0;
  bottom: 0;
  left: 0;
}

.ff-right {
  top: 20%;
  right: 0;
  width: min(360px, calc(100vw - 24px));
}

.ff-bar {
  display: flex;
  width: 100%;
  min-height: 34px;
  align-items: center;
  gap: 10px;
  border: 1px solid var(--ff-border);
  background: var(--ff-bg);
  color: var(--ff-text);
  padding: 7px 12px;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.ff-bottom .ff-bar {
  border-width: 1px 0 0;
}

.ff-brand {
  color: var(--ff-primary);
  font-weight: 800;
}

.ff-route {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ff-count {
  margin-left: auto;
  color: var(--ff-muted);
  white-space: nowrap;
}

.ff-panel {
  border: 1px solid var(--ff-border);
  border-bottom: 0;
  background: var(--ff-panel);
  color: var(--ff-text);
  padding: 16px;
}

.ff-right .ff-panel {
  border-right: 0;
  border-bottom: 1px solid var(--ff-border);
}

.ff-panel-title {
  margin: 0 0 4px;
  font-size: 13px;
}

.ff-panel-copy {
  margin: 0;
  color: var(--ff-muted);
}

.ff-bar:focus-visible {
  outline: 2px solid var(--ff-primary);
  outline-offset: -3px;
}
`;
