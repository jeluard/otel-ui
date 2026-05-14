// ── History REST client ────────────────────────────────────────────────────────
// Mirrors the WS_URL logic: in dev mode the backend is on 8081.

import type { TraceComplete, TraceBounds } from './types.ts';

const API_BASE = (() => {
  const { hostname, port, protocol } = window.location;
  // In dev with frontend fallback ports (8082+), backend is still on 8081
  const devFallbackPorts = new Set(['8080', '8082', '8083', '8084', '8085', '8090', '3000']);
  if (devFallbackPorts.has(port)) return `${protocol}//${hostname}:8081`;
  // Otherwise use same port (assumes backend on same host)
  return `${protocol}//${hostname}${port ? ':' + port : ''}`;
})();

export async function fetchBounds(): Promise<TraceBounds | null> {
  try {
    const res = await fetch(`${API_BASE}/api/traces/bounds`);
    if (!res.ok) return null;
    return res.json() as Promise<TraceBounds | null>;
  } catch {
    return null;
  }
}

export interface TraceQueryFilters {
  service?: string;
  min_duration_ms?: number;
  max_duration_ms?: number;
}

/**
 * Query persisted traces in the time range [from_ns, to_ns] (nanoseconds).
 * Returns at most `limit` traces ordered by started_at ascending.
 */
export async function fetchTraces(
  from_ns: number,
  to_ns: number,
  limit = 2000,
  filters: TraceQueryFilters = {},
): Promise<TraceComplete[]> {
  try {
    const params = new URLSearchParams({
      from:  String(from_ns),
      to:    String(to_ns),
      limit: String(limit),
    });
    if (filters.service)          params.set('service',        filters.service);
    if (filters.min_duration_ms != null) params.set('min_duration_ms', String(filters.min_duration_ms));
    if (filters.max_duration_ms != null) params.set('max_duration_ms', String(filters.max_duration_ms));
    const res = await fetch(`${API_BASE}/api/traces?${params}`);
    if (!res.ok) return [];
    return res.json() as Promise<TraceComplete[]>;
  } catch {
    return [];
  }
}

