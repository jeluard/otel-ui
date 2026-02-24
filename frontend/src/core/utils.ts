// ── Pure utility helpers shared across modules ───────────────────────────────

/** Linear-interpolation percentile over a pre-sorted ascending array. */
export function pctile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const i  = (sorted.length - 1) * p;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

/** Format nanosecond timestamp as HH:MM:SS.mmm */
export function fmtTime(nanos: number): string {
  if (!nanos) return '—';
  const d = new Date(nanos / 1_000_000);
  return String(d.getHours()).padStart(2, '0') + ':' +
         String(d.getMinutes()).padStart(2, '0') + ':' +
         String(d.getSeconds()).padStart(2, '0') + '.' +
         String(d.getMilliseconds()).padStart(3, '0');
}

/** Format a millisecond duration as a human-readable string. */
export function fmtDur(ms: number): string {
  if (ms <= 0)    return '—';
  if (ms >= 1000) return `${parseFloat((ms / 1000).toFixed(2))}s`;
  if (ms >= 1)    return `${parseFloat(ms.toFixed(2))}ms`;
  return `${(ms * 1000).toFixed(0)}µs`;
}

/** Escape a string for safe insertion into HTML. */
export function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Heatmap helpers ───────────────────────────────────────────────────────────

/** Latency bucket edges (ms). */
export const HM_EDGES = [0, 0.1, 0.5, 1, 5, 20, 100, 500, Infinity] as const;
/** Number of latency rows = HM_EDGES.length - 1 */
export const HM_ROWS  = HM_EDGES.length - 1;

/** Map a duration (ms) to its heatmap row index. */
export function msToHmRow(ms: number): number {
  for (let i = 0; i < HM_EDGES.length - 1; i++)
    if (ms < HM_EDGES[i + 1]) return i;
  return HM_ROWS - 1;
}

/** Dark-blue → cyan → near-white colour ramp for heatmap cells (Grafana-inspired). */
export function hmCellColor(t: number): string {
  if (t <= 0) return 'transparent';
  const a = Math.pow(t, 0.55); // gamma so sparse cells stay visible
  let r: number, g: number, b: number;
  if (a < 0.5) {
    const u = a / 0.5;
    r = Math.round(5   + u *   9);
    g = Math.round(20  + u * 148);
    b = Math.round(55  + u * 185);
  } else {
    const u = (a - 0.5) / 0.5;
    r = Math.round(14  + u * 186);
    g = Math.round(168 + u *  77);
    b = Math.round(240 + u *  15);
  }
  return `rgba(${r},${g},${b},${+(Math.min(1, 0.15 + a * 0.88)).toFixed(2)})`;
}
