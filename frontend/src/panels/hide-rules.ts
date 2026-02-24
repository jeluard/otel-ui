// ── Span hide-rules: logic, persistence, and dialog UI ──────────────────────

import type { SpanEvent } from '../core/types.ts';

export interface HideRule { target: string; name?: string; }

const HIDE_STORAGE_KEY     = 'otel_ui_hide_rules';
const DEFAULT_FILTERS_PATH = './default-filters.json';

// Private backing array — always an array, never null.
// Imported modules get a live reference to this same array object.
const _rules: HideRule[] = [];
let _initialised = false;

// Immediately seed from localStorage if the user has saved preferences.
(function () {
  if (typeof localStorage === 'undefined' || typeof localStorage.getItem !== 'function') return;
  const raw = localStorage.getItem(HIDE_STORAGE_KEY);
  if (!raw) return;
  try {
    const parsed = JSON.parse(raw) as HideRule[];
    _rules.push(...parsed);
    _initialised = true;
  } catch { /* bad JSON — treat as missing */ }
})();

/** Live reference to the hide-rules array. Always the same object; mutated in place. */
export const hiddenRules: HideRule[] = _rules;

function saveRules(): void {
  if (typeof localStorage === 'undefined' || typeof localStorage.setItem !== 'function') return;
  localStorage.setItem(HIDE_STORAGE_KEY, JSON.stringify(hiddenRules));
}

function targetMatches(spanTarget: string, ruleTarget: string): boolean {
  if (ruleTarget.endsWith('*')) {
    const prefix = ruleTarget.slice(0, -1);
    return spanTarget === prefix || spanTarget.startsWith(prefix);
  }
  return spanTarget === ruleTarget;
}

export function isSpanHidden(span: { name: string; target: string }): boolean {
  if (!hiddenRules.length) return false;
  for (const rule of hiddenRules) {
    if (!targetMatches(span.target, rule.target)) continue;
    if (rule.name !== undefined && rule.name !== span.name) continue;
    return true;
  }
  return false;
}

/** Filter spans by hide rules, re-parenting children of hidden spans to nearest visible ancestor. */
export function filterSpans(spans: SpanEvent[]): SpanEvent[] {
  if (!hiddenRules.length) return spans;
  const byId = new Map<string, SpanEvent>();
  for (const s of spans) byId.set(s.span_id, s);
  function effectiveParent(pid: string | null | undefined): string | null {
    if (!pid) return null;
    const p = byId.get(pid);
    if (!p) return null;
    if (!isSpanHidden(p)) return p.span_id;
    return effectiveParent(p.parent_span_id ?? null);
  }
  return spans
    .filter(s => !isSpanHidden(s))
    .map(s => {
      if (!s.parent_span_id) return s;
      const p = byId.get(s.parent_span_id);
      if (!p || !isSpanHidden(p)) return s;
      return { ...s, parent_span_id: effectiveParent(p.parent_span_id ?? null) };
    });
}

/** Fetch /default-filters.json and seed hiddenRules + localStorage on first visit. */
export async function loadDefaultFilters(): Promise<void> {
  // Migrate: the old default shipped `[{"target":"*"}]` which hides everything.
  // If that's the only rule saved, auto-reset it so users aren't stuck.
  if (_initialised) {
    const isLegacyWildcard =
      hiddenRules.length === 1 &&
      hiddenRules[0].target === '*' &&
      hiddenRules[0].name === undefined;
    if (!isLegacyWildcard) return; // genuine user prefs — leave them alone
    hiddenRules.splice(0, hiddenRules.length);
    _initialised = false;
  }

  try {
    const res = await fetch(DEFAULT_FILTERS_PATH);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const defaults = await res.json() as HideRule[];
    hiddenRules.splice(0, 0, ...defaults);
    saveRules();
  } catch (err) {
    console.warn('[otel-ui] Could not load default-filters.json:', err);
    // Leave hiddenRules as empty array
  }
  _initialised = true;
}

/** Add a validated rule (no-op if duplicate or empty target). */
export function addHideRule(rule: HideRule): void {
  const t = rule.target.trim();
  const n = rule.name?.trim();
  if (!t) return;
  const norm: HideRule = n ? { target: t, name: n } : { target: t };
  if (hiddenRules.some(r => r.target === norm.target && r.name === norm.name)) return;
  hiddenRules.push(norm);
  saveRules();
}

/** Remove rule at index `i`. */
export function removeHideRule(i: number): void {
  hiddenRules.splice(i, 1);
  saveRules();
}

/** Reset rules to the defaults from the server. */
export async function resetHideRulesToDefaults(): Promise<void> {
  try {
    const res = await fetch(DEFAULT_FILTERS_PATH);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const defaults = await res.json() as HideRule[];
    hiddenRules.splice(0, hiddenRules.length, ...defaults);
  } catch {
    hiddenRules.splice(0, hiddenRules.length);
  }
  saveRules();
}
