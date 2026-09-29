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
  --ff-primary-soft: #dbeafe;
  --ff-success: #15803d;
  --ff-warning: #b45309;
  --ff-danger: #b91c1c;
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
  --ff-primary-soft: #172554;
  --ff-success: #4ade80;
  --ff-warning: #fbbf24;
  --ff-danger: #f87171;
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
    --ff-primary-soft: #172554;
    --ff-success: #4ade80;
    --ff-warning: #fbbf24;
    --ff-danger: #f87171;
  }
}

.ff-bottom {
  right: 0;
  bottom: 0;
  left: 0;
}

.ff-right {
  top: 10%;
  right: 0;
  width: min(520px, calc(100vw - 24px));
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

.ff-bar-stat {
  flex: 0 0 auto;
  color: var(--ff-muted);
  white-space: nowrap;
}

.ff-bar-stat + .ff-bar-stat::before {
  content: "│";
  margin-right: 10px;
  color: var(--ff-border);
}

.ff-errors {
  color: var(--ff-danger);
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
  color: var(--ff-primary);
  font-weight: 700;
  white-space: nowrap;
}

.ff-panel {
  border: 1px solid var(--ff-border);
  border-bottom: 0;
  background: var(--ff-panel);
  color: var(--ff-text);
  max-height: min(72vh, 680px);
  overflow: auto;
}

.ff-right .ff-panel {
  border-right: 0;
  border-bottom: 1px solid var(--ff-border);
}

.ff-panel-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 14px 16px 12px;
}

.ff-panel-title {
  margin: 0;
  font-size: 15px;
  line-height: 1.2;
}

.ff-eyebrow {
  margin: 0 0 2px;
  color: var(--ff-muted);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.ff-recording {
  color: var(--ff-muted);
  white-space: nowrap;
}

.ff-tabs {
  display: flex;
  gap: 4px;
  border-block: 1px solid var(--ff-border);
  padding: 0 12px;
}

.ff-tab {
  appearance: none;
  border: 0;
  border-bottom: 2px solid transparent;
  background: transparent;
  color: var(--ff-muted);
  padding: 9px 10px 7px;
  font: inherit;
  font-weight: 700;
  cursor: pointer;
}

.ff-tab[aria-selected="true"] {
  border-bottom-color: var(--ff-primary);
  color: var(--ff-primary);
}

.ff-tab-panel {
  padding: 14px 16px 16px;
}

.ff-context-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 8px;
}

.ff-context-card {
  min-width: 0;
  border: 1px solid var(--ff-border);
  border-radius: 6px;
  background: var(--ff-bg);
  padding: 10px;
}

.ff-context-card span {
  display: block;
  margin-bottom: 4px;
  color: var(--ff-muted);
  font-size: 10px;
  text-transform: uppercase;
}

.ff-context-card strong {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ff-summary-section {
  margin-top: 14px;
}

.ff-summary-section h3 {
  margin: 0 0 7px;
  font-size: 11px;
  text-transform: uppercase;
}

.ff-metric-grid {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 1px;
  margin: 0;
  overflow: hidden;
  border: 1px solid var(--ff-border);
  border-radius: 6px;
  background: var(--ff-border);
}

.ff-metric {
  min-width: 0;
  background: var(--ff-panel);
  padding: 8px 10px;
}

.ff-metric dt {
  overflow: hidden;
  color: var(--ff-muted);
  font-size: 10px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ff-metric dd {
  overflow-wrap: anywhere;
  margin: 2px 0 0;
  font-weight: 800;
}

.ff-table-scroll {
  max-width: 100%;
  overflow: auto;
  border: 1px solid var(--ff-border);
  border-radius: 6px;
}

.ff-table {
  width: 100%;
  min-width: 720px;
  border-collapse: collapse;
  text-align: left;
}

.ff-table caption {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  clip-path: inset(50%);
}

.ff-table th,
.ff-table td {
  max-width: 210px;
  border-bottom: 1px solid var(--ff-border);
  padding: 8px 10px;
  white-space: nowrap;
}

.ff-table thead th {
  position: sticky;
  top: 0;
  z-index: 1;
  background: var(--ff-bg);
  color: var(--ff-muted);
  font-size: 10px;
  text-transform: uppercase;
}

.ff-table tbody tr {
  cursor: pointer;
}

.ff-table tbody tr:hover,
.ff-table tbody tr[data-selected="true"] {
  background: var(--ff-primary-soft);
}

.ff-table tbody tr:last-child th,
.ff-table tbody tr:last-child td {
  border-bottom: 0;
}

.ff-resource-button,
.ff-secondary-button {
  appearance: none;
  border: 0;
  background: transparent;
  color: var(--ff-primary);
  padding: 0;
  font: inherit;
  font-weight: 800;
  cursor: pointer;
}

.ff-secondary-button {
  border: 1px solid var(--ff-border);
  border-radius: 5px;
  padding: 5px 8px;
}

.ff-status {
  display: inline-block;
  border: 1px solid var(--ff-border);
  border-radius: 999px;
  padding: 1px 7px;
}

.ff-status-ready {
  color: var(--ff-success);
}

.ff-status-pending,
.ff-status-loading {
  color: var(--ff-warning);
}

.ff-status-error {
  color: var(--ff-danger);
}

.ff-truncate {
  overflow: hidden;
  text-overflow: ellipsis;
}

.ff-resource-detail {
  margin-top: 12px;
  border: 1px solid var(--ff-border);
  border-radius: 6px;
  background: var(--ff-bg);
  padding: 12px;
}

.ff-detail-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 10px;
}

.ff-detail-heading h3 {
  margin: 0;
  font-size: 13px;
  overflow-wrap: anywhere;
}

.ff-detail-list {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 1px;
  margin: 0;
  overflow: hidden;
  border: 1px solid var(--ff-border);
  border-radius: 5px;
  background: var(--ff-border);
}

.ff-empty {
  margin: 0;
  border: 1px dashed var(--ff-border);
  border-radius: 6px;
  color: var(--ff-muted);
  padding: 20px;
  text-align: center;
}

.ff-timeline-controls {
  display: flex;
  align-items: flex-end;
  gap: 8px;
}

.ff-search-label {
  display: grid;
  flex: 1;
  gap: 4px;
  color: var(--ff-muted);
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
}

.ff-search-label input {
  width: 100%;
  min-height: 32px;
  border: 1px solid var(--ff-border);
  border-radius: 5px;
  background: var(--ff-bg);
  color: var(--ff-text);
  padding: 6px 9px;
  font: inherit;
  text-transform: none;
}

.ff-secondary-button:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}

.ff-filter-list {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  margin-top: 10px;
}

.ff-filter {
  appearance: none;
  border: 1px solid var(--ff-border);
  border-radius: 999px;
  background: var(--ff-panel);
  color: var(--ff-muted);
  padding: 3px 8px;
  font: inherit;
  font-size: 10px;
  text-transform: capitalize;
  cursor: pointer;
}

.ff-filter[aria-pressed="true"] {
  border-color: var(--ff-primary);
  background: var(--ff-primary-soft);
  color: var(--ff-primary);
}

.ff-timeline-meta {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  margin: 10px 0 6px;
  color: var(--ff-muted);
  font-size: 10px;
}

.ff-timeline-meta span:last-child {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ff-timeline {
  display: grid;
  gap: 1px;
  margin: 0;
  overflow: hidden;
  border: 1px solid var(--ff-border);
  border-radius: 6px;
  background: var(--ff-border);
  padding: 0;
  list-style: none;
}

.ff-timeline-row {
  display: grid;
  grid-template-columns: 104px 150px minmax(0, 1fr) 64px;
  width: 100%;
  align-items: center;
  gap: 10px;
  border: 0;
  background: var(--ff-panel);
  color: var(--ff-text);
  padding: 7px 9px;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.ff-timeline-row:hover,
.ff-timeline-row[data-correlated="true"] {
  background: var(--ff-primary-soft);
}

.ff-timeline-row[data-selected="true"] {
  box-shadow: inset 3px 0 0 var(--ff-primary);
}

.ff-timeline-row[data-error="true"] .ff-timeline-category {
  color: var(--ff-danger);
}

.ff-timeline-row time,
.ff-timeline-duration {
  color: var(--ff-muted);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.ff-timeline-category {
  overflow: hidden;
  color: var(--ff-primary);
  font-size: 10px;
  font-weight: 800;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ff-category-cache {
  color: var(--ff-warning);
}

.ff-category-live {
  color: var(--ff-success);
}

.ff-category-error {
  color: var(--ff-danger);
}

.ff-timeline-summary {
  min-width: 0;
}

.ff-timeline-summary strong,
.ff-timeline-summary small {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ff-timeline-summary small {
  color: var(--ff-muted);
  font-size: 10px;
  font-weight: 500;
}

.ff-timeline-duration {
  text-align: right;
}

.ff-waterfall {
  margin-bottom: 10px;
  border: 1px solid var(--ff-border);
  border-radius: 6px;
  background: var(--ff-bg);
  padding: 10px;
}

.ff-waterfall h3 {
  margin: 0 0 7px;
  font-size: 11px;
  text-transform: uppercase;
}

.ff-waterfall ol {
  display: grid;
  gap: 5px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.ff-waterfall li {
  display: grid;
  grid-template-columns: 120px minmax(120px, 1fr) 60px;
  align-items: center;
  gap: 8px;
}

.ff-waterfall li > span:first-child {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ff-waterfall li strong {
  color: var(--ff-muted);
  text-align: right;
}

.ff-waterfall-track {
  position: relative;
  display: block;
  height: 8px;
  overflow: hidden;
  border-radius: 999px;
  background: var(--ff-border);
}

.ff-waterfall-bar {
  position: absolute;
  top: 0;
  bottom: 0;
  left: var(--ff-waterfall-offset);
  width: var(--ff-waterfall-duration);
  min-width: 2px;
  border-radius: inherit;
  background: var(--ff-primary);
}

.ff-bar:focus-visible,
.ff-tab:focus-visible,
.ff-resource-button:focus-visible,
.ff-secondary-button:focus-visible,
.ff-table-scroll:focus-visible,
.ff-filter:focus-visible,
.ff-timeline-row:focus-visible,
.ff-search-label input:focus-visible {
  outline: 2px solid var(--ff-primary);
  outline-offset: 2px;
}

.ff-bar:focus-visible {
  outline-offset: -3px;
}

@media (max-width: 840px) {
  .ff-context-grid,
  .ff-detail-list {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .ff-metric-grid {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }

  .ff-bar {
    flex-wrap: wrap;
  }

  .ff-timeline-row {
    grid-template-columns: 96px 130px minmax(0, 1fr);
  }

  .ff-timeline-duration {
    display: none;
  }
}

@media (max-width: 520px) {
  .ff-context-grid,
  .ff-detail-list {
    grid-template-columns: 1fr;
  }

  .ff-metric-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .ff-panel-heading {
    align-items: flex-start;
  }

  .ff-recording {
    white-space: normal;
    text-align: right;
  }

  .ff-timeline-row {
    grid-template-columns: 86px minmax(0, 1fr);
  }

  .ff-timeline-category {
    display: none;
  }

  .ff-waterfall li {
    grid-template-columns: 84px minmax(80px, 1fr) 54px;
  }
}
`;
