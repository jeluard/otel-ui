import { describe, it, expect } from 'vitest';
import { pctile, fmtDur, fmtTime, escHtml, msToHmRow, hmCellColor, HM_EDGES } from '../core/utils.ts';

describe('pctile', () => {
  it('returns 0 on empty array', () => {
    expect(pctile([], 0.5)).toBe(0);
  });

  it('returns the single element for any p on a singleton', () => {
    expect(pctile([42], 0.0)).toBe(42);
    expect(pctile([42], 0.5)).toBe(42);
    expect(pctile([42], 1.0)).toBe(42);
  });

  it('returns min/max at p=0 and p=1', () => {
    const s = [1, 2, 3, 4, 5];
    expect(pctile(s, 0)).toBe(1);
    expect(pctile(s, 1)).toBe(5);
  });

  it('interpolates p50 correctly', () => {
    expect(pctile([0, 10], 0.5)).toBe(5);
    expect(pctile([0, 10, 20], 0.5)).toBe(10);
  });
});

describe('fmtDur', () => {
  it('returns — for zero or negative', () => {
    expect(fmtDur(0)).toBe('—');
    expect(fmtDur(-1)).toBe('—');
  });

  it('formats microseconds (< 1ms)', () => {
    expect(fmtDur(0.5)).toBe('500µs');
  });

  it('formats milliseconds (1–999ms)', () => {
    expect(fmtDur(1)).toBe('1ms');
    expect(fmtDur(123.456)).toBe('123.46ms');
  });

  it('formats seconds (>= 1000ms)', () => {
    expect(fmtDur(1000)).toBe('1s');
    expect(fmtDur(1500)).toBe('1.5s');
  });
});

describe('fmtTime', () => {
  it('returns — for falsy input', () => {
    expect(fmtTime(0)).toBe('—');
  });

  it('returns HH:MM:SS.mmm format', () => {
    const result = fmtTime(Date.UTC(2024, 0, 1, 12, 34, 56, 789) * 1_000_000);
    expect(result).toMatch(/^\d{2}:\d{2}:\d{2}\.\d{3}$/);
  });
});

describe('escHtml', () => {
  it('escapes &, <, >, "', () => {
    expect(escHtml('a & b')).toBe('a &amp; b');
    expect(escHtml('<script>')).toBe('&lt;script&gt;');
    expect(escHtml('"hello"')).toBe('&quot;hello&quot;');
  });

  it('leaves safe text unchanged', () => {
    expect(escHtml('hello world')).toBe('hello world');
  });
});

describe('msToHmRow', () => {
  it('returns 0 for 0ms', () => {
    expect(msToHmRow(0)).toBe(0);
  });

  it('maps each bucket correctly', () => {
    const edges = HM_EDGES as unknown as number[];
    for (let i = 0; i < edges.length - 2; i++) {
      const mid = (edges[i] + edges[i + 1]) / 2;
      expect(msToHmRow(mid)).toBe(i);
    }
  });

  it('clamps to last bucket for very large values', () => {
    expect(msToHmRow(1_000_000)).toBe(HM_EDGES.length - 2);
  });
});

describe('hmCellColor', () => {
  it('returns transparent for t=0', () => {
    expect(hmCellColor(0)).toBe('transparent');
  });

  it('returns an rgba string for t > 0', () => {
    const color = hmCellColor(0.5);
    expect(color).toMatch(/^rgba\(\d+,\d+,\d+,[\d.]+\)$/);
  });

  it('produces brighter color for t=1 vs t=0.1', () => {
    const bright = hmCellColor(1);
    const dim    = hmCellColor(0.1);
    expect(bright).not.toBe(dim);
  });
});
