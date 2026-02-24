import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { SpanEvent } from '../core/types.ts';

// ── Shared test helpers ───────────────────────────────────────────────────────

function makeSpan(overrides: Partial<SpanEvent> & { name: string; target: string }): SpanEvent {
  return {
    trace_id:             'trace-001',
    span_id:              `span-${overrides.name}`,
    parent_span_id:       null,
    start_time_unix_nano: 0,
    end_time_unix_nano:   1_000_000,
    duration_ms:          1,
    attributes:           [],
    status:               'ok',
    service_name:         overrides.target,
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('hide-rules module', () => {
  // Re-import after each test to reset module state.
  // We use vi.resetModules + dynamic import so each test starts fresh.
  beforeEach(() => {
    vi.resetModules();
    // Provide a fresh in-memory localStorage mock (jsdom's may be degraded)
    const store: Record<string, string> = {};
    vi.stubGlobal('localStorage', {
      getItem:    (k: string) => store[k] ?? null,
      setItem:    (k: string, v: string) => { store[k] = v; },
      removeItem: (k: string) => { delete store[k]; },
      clear:      () => { Object.keys(store).forEach(k => delete store[k]); },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function load() {
    const mod = await import('../panels/hide-rules.ts');
    return mod;
  }

  it('isSpanHidden: returns false when no rules', async () => {
    const { isSpanHidden } = await load();
    const span = makeSpan({ name: 'health_check', target: 'actix-web' });
    expect(isSpanHidden(span)).toBe(false);
  });

  it('isSpanHidden: matches by target wildcard', async () => {
    const { hiddenRules, isSpanHidden } = await load();
    hiddenRules.push({ target: 'actix*' });
    const span = makeSpan({ name: 'x', target: 'actix-web' });
    expect(isSpanHidden(span)).toBe(true);
  });

  it('isSpanHidden: matches by exact target', async () => {
    const { hiddenRules, isSpanHidden } = await load();
    hiddenRules.push({ target: 'grpc' });
    expect(isSpanHidden(makeSpan({ name: 'x', target: 'grpc' }))).toBe(true);
    expect(isSpanHidden(makeSpan({ name: 'x', target: 'http' }))).toBe(false);
  });

  it('isSpanHidden: matches by target + name combo', async () => {
    const { hiddenRules, isSpanHidden } = await load();
    hiddenRules.push({ target: 'actix-web', name: 'health_check' });
    expect(isSpanHidden(makeSpan({ name: 'health_check', target: 'actix-web' }))).toBe(true);
    expect(isSpanHidden(makeSpan({ name: 'user_create', target: 'actix-web' }))).toBe(false);
  });

  it('filterSpans: returns all spans when no rules', async () => {
    const { filterSpans } = await load();
    const spans = [makeSpan({ name: 'a', target: 'x' }), makeSpan({ name: 'b', target: 'y' })];
    expect(filterSpans(spans)).toHaveLength(2);
  });

  it('filterSpans: removes matching spans', async () => {
    const { hiddenRules, filterSpans } = await load();
    hiddenRules.push({ target: 'x', name: 'a' });
    const spans = [makeSpan({ name: 'a', target: 'x' }), makeSpan({ name: 'b', target: 'y' })];
    const result = filterSpans(spans);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('b');
  });

  it('addHideRule: appends rule and saves to localStorage', async () => {
    const { addHideRule, hiddenRules } = await load();
    addHideRule({ target: 'redis' });
    expect(hiddenRules).toHaveLength(1);
    expect(hiddenRules[0].target).toBe('redis');
    expect(localStorage.getItem('otel_ui_hide_rules')).toContain('redis');
  });

  it('addHideRule: does not add duplicate', async () => {
    const { addHideRule, hiddenRules } = await load();
    addHideRule({ target: 'redis' });
    addHideRule({ target: 'redis' });
    expect(hiddenRules).toHaveLength(1);
  });

  it('addHideRule: ignores empty target', async () => {
    const { addHideRule, hiddenRules } = await load();
    addHideRule({ target: '  ' });
    expect(hiddenRules).toHaveLength(0);
  });

  it('removeHideRule: removes rule by index', async () => {
    const { hiddenRules, addHideRule, removeHideRule } = await load();
    addHideRule({ target: 'a' });
    addHideRule({ target: 'b' });
    removeHideRule(0);
    expect(hiddenRules).toHaveLength(1);
    expect(hiddenRules[0].target).toBe('b');
  });
});

// ── calcDepths (from TracesPanel) ─────────────────────────────────────────────

import { calcDepths } from '../components/TracesPanel.tsx';

describe('calcDepths', () => {
  it('returns depth 0 for root span', () => {
    const spans: SpanEvent[] = [makeSpan({ span_id: 'root', name: 'root', target: 'svc', parent_span_id: null })];
    spans[0].span_id = 'root';
    const depths = calcDepths(spans);
    expect(depths.get('root')).toBe(0);
  });

  it('assigns depth 1 to direct child', () => {
    const root  = makeSpan({ name: 'root',  target: 'svc' });
    root.span_id = 'root'; root.parent_span_id = null;
    const child = makeSpan({ name: 'child', target: 'svc' });
    child.span_id = 'child'; child.parent_span_id = 'root';
    const depths = calcDepths([root, child]);
    expect(depths.get('child')).toBe(1);
  });

  it('handles linear chains', () => {
    const spans: SpanEvent[] = ['s1', 's2', 's3'].map((id, i) => {
      const s = makeSpan({ name: id, target: 'svc' });
      s.span_id        = id;
      s.parent_span_id = i === 0 ? null : `s${i}`;
      return s;
    });
    const depths = calcDepths(spans);
    expect(depths.get('s1')).toBe(0);
    expect(depths.get('s2')).toBe(1);
    expect(depths.get('s3')).toBe(2);
  });
});
