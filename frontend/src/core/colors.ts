// ── Dynamic per-target colour palette ───────────────────────────────────────
// Values are read from CSS custom properties so the entire palette lives in CSS.

import { fillGlow } from './theme.ts';

const _cs = getComputedStyle(document.documentElement);
const pv = (name: string) => _cs.getPropertyValue(name).trim();

function pe(i: number | 'f') {
  const fill = pv(`--p${i}-fill`);
  const text = pv(`--p${i}-text`);
  return { fill, text, glow: fillGlow(fill) };
}

const TARGET_PALETTE = [
  pe(0), pe(1), pe(2),  pe(3),  pe(4),  pe(5),
  pe(6), pe(7), pe(8),  pe(9),  pe(10), pe(11),
];

const FALLBACK = pe('f');

// target string → palette index (assigned on first use)
const assignedTargets = new Map<string, number>();
let _nextIdx = 0;

/** Truncate a target to at most 2 `::` levels, e.g. `test::ledger::state` → `test::ledger`. */
function normalizeTarget(target: string): string {
  const parts = target.split('::');
  return parts.slice(0, 2).join('::');
}

export function targetColor(target: string) {
  const normalized = normalizeTarget(target);
  let idx = assignedTargets.get(normalized);
  if (idx === undefined) {
    idx = _nextIdx++ % TARGET_PALETTE.length;
    assignedTargets.set(normalized, idx);
  }
  return TARGET_PALETTE[idx] ?? FALLBACK;
}

/** Returns all targets that have been assigned a colour, sorted alphabetically. */
export function getAssignedTargets(): Array<{ target: string; color: { fill: string; text: string } }> {
  return Array.from(assignedTargets.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([target, idx]) => ({ target, color: TARGET_PALETTE[idx % TARGET_PALETTE.length]! }));
}


