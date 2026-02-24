// ── Color tokens — single source of truth, driven by CSS custom properties ───
//
// All values are read from :root CSS variables at module-load time (after the
// stylesheet has been applied).  Canvas drawing code uses `C.xxx` everywhere
// instead of hardcoded hex or rgba strings so the whole palette lives in CSS.

const _s = getComputedStyle(document.documentElement);
const v = (name: string): string => _s.getPropertyValue(name).trim();

export const C = {
  // ── Base ─────────────────────────────────────────────────────────────────
  bg:             v('--c-bg'),
  labelBgRgb:     v('--c-label-bg-rgb'),    // RGB triple for rgba() in canvas

  // ── Status ───────────────────────────────────────────────────────────────
  ok:             v('--c-ok'),
  error:          v('--c-error'),
  rose:           v('--c-rose'),
  amber:          v('--c-amber'),

  // ── Accent ───────────────────────────────────────────────────────────────
  cyan:           v('--c-cyan'),
  sparkline:      v('--c-sparkline'),
  sparklineRgb:   v('--c-sparkline-rgb'),   // RGB triple for rgba() in canvas
  p50:            v('--c-p50'),
  p50Rgb:         v('--c-p50-rgb'),         // RGB triple for rgba() in canvas
  p95:            v('--c-p95'),

  // ── Neutral text / UI ────────────────────────────────────────────────────
  muted:          v('--c-muted'),
  dim:            v('--c-dim'),
  neutral:        v('--c-neutral'),
  subtle:         v('--c-subtle'),
  subtleRgb:      v('--c-subtle-rgb'),      // RGB triple for rgba() in canvas
  onFill:         v('--c-on-fill'),

  // ── Canvas static rgba values ────────────────────────────────────────────
  nodeBg0:        v('--c-node-bg-0'),
  nodeBg1:        v('--c-node-bg-1'),
  colGuideStroke: v('--c-colguide-stroke'),
  colGuideFill:   v('--c-colguide-fill'),
  dotActive:      v('--c-dot-active'),
  dotInactive:    v('--c-dot-inactive'),
  selRing:        v('--c-sel-ring'),

  // ── Minimap ───────────────────────────────────────────────────────────────
  minimapBg:      v('--c-minimap-bg'),
  minimapBorder:  v('--c-minimap-border'),
  minimapEdge:    v('--c-minimap-edge'),
  minimapVp:      v('--c-minimap-vp'),
} as const;

/** Derive a 40%-opacity glow rgba string from a hex fill colour. */
export function fillGlow(hex: string): string {
  const n = parseInt(hex.replace('#', ''), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},0.4)`;
}
