import { describe, it, expect } from 'vitest';
import { edgeWouldCreateCycle, computeSelectionHighlight } from '../core/graph.ts';
import type { Edge } from '../core/types.ts';

// ── edgeWouldCreateCycle ──────────────────────────────────────────────────────

describe('edgeWouldCreateCycle', () => {
  it('returns true for self-loop', () => {
    expect(edgeWouldCreateCycle('A', 'A', [])).toBe(true);
  });

  it('returns false for an edge on an empty graph', () => {
    expect(edgeWouldCreateCycle('A', 'B', [])).toBe(false);
  });

  it('detects a direct cycle A→B when B→A exists', () => {
    const edges: Edge[] = [{ source: 'B', target: 'A', flow_count: 0 }];
    expect(edgeWouldCreateCycle('A', 'B', edges)).toBe(true);
  });

  it('detects a transitive cycle A→B when B→C→A exists', () => {
    const edges: Edge[] = [
      { source: 'B', target: 'C', flow_count: 0 },
      { source: 'C', target: 'A', flow_count: 0 },
    ];
    expect(edgeWouldCreateCycle('A', 'B', edges)).toBe(true);
  });

  it('allows adding a new edge to a DAG without a cycle', () => {
    const edges: Edge[] = [
      { source: 'A', target: 'B', flow_count: 0 },
      { source: 'B', target: 'C', flow_count: 0 },
    ];
    // Adding A→C is fine (no cycle)
    expect(edgeWouldCreateCycle('A', 'C', edges)).toBe(false);
    // Adding C→D is fine
    expect(edgeWouldCreateCycle('C', 'D', edges)).toBe(false);
  });
});

// ── computeSelectionHighlight ────────────────────────────────────────────────

describe('computeSelectionHighlight', () => {
  const edges: Edge[] = [
    { source: 'A', target: 'B', flow_count: 0 },
    { source: 'B', target: 'C', flow_count: 0 },
    { source: 'D', target: 'B', flow_count: 0 },
  ];

  it('always includes the selected node', () => {
    const { nodes } = computeSelectionHighlight('B', edges);
    expect(nodes.has('B')).toBe(true);
  });

  it('includes ancestors (upstream) of selected node', () => {
    const { nodes } = computeSelectionHighlight('B', edges);
    expect(nodes.has('A')).toBe(true);
    expect(nodes.has('D')).toBe(true);
  });

  it('includes descendants (downstream) of selected node', () => {
    const { nodes } = computeSelectionHighlight('B', edges);
    expect(nodes.has('C')).toBe(true);
  });

  it('collects edge keys for connected edges', () => {
    const { edgeKeys } = computeSelectionHighlight('B', edges);
    expect(edgeKeys.has('A=>B')).toBe(true);
    expect(edgeKeys.has('B=>C')).toBe(true);
    expect(edgeKeys.has('D=>B')).toBe(true);
  });

  it('excludes unrelated nodes', () => {
    const { nodes } = computeSelectionHighlight('A', edges);
    expect(nodes.has('D')).toBe(false);
  });

  it('works with isolated node (no edges)', () => {
    const { nodes, edgeKeys } = computeSelectionHighlight('Z', edges);
    expect(nodes.has('Z')).toBe(true);
    expect(edgeKeys.size).toBe(0);
  });

  it('handles linear chains correctly from tail', () => {
    const chain: Edge[] = [
      { source: 'X', target: 'Y', flow_count: 0 },
      { source: 'Y', target: 'Z', flow_count: 0 },
    ];
    const { nodes } = computeSelectionHighlight('Z', chain);
    expect(nodes.has('X')).toBe(true);
    expect(nodes.has('Y')).toBe(true);
    expect(nodes.has('Z')).toBe(true);
  });
});
