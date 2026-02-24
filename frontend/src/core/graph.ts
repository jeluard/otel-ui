// ── Graph algorithms used by layout and selection highlight ──────────────────

import type { Edge } from './types.ts';

/**
 * Returns true if adding source→target to edgeList would create a cycle.
 * Equivalent to: can 'target' already reach 'source' in edgeList?
 */
export function edgeWouldCreateCycle(source: string, target: string, edgeList: Edge[]): boolean {
  if (source === target) return true;
  const adj = new Map<string, string[]>();
  for (const e of edgeList) {
    const arr = adj.get(e.source);
    if (arr) arr.push(e.target); else adj.set(e.source, [e.target]);
  }
  const visited = new Set<string>();
  const stack   = [target];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (cur === source) return true;
    if (visited.has(cur)) continue;
    visited.add(cur);
    for (const next of adj.get(cur) ?? []) stack.push(next);
  }
  return false;
}

/**
 * Compute the set of nodes and edge-keys reachable from `nodeId` both
 * backwards (ancestors) and forwards (descendants) in the edge graph.
 * The selected node itself is always included.
 */
export function computeSelectionHighlight(
  nodeId: string,
  edgeList: Edge[],
): { nodes: Set<string>; edgeKeys: Set<string> } {
  const fwd = new Map<string, string[]>(); // source → targets
  const bwd = new Map<string, string[]>(); // target → sources
  for (const e of edgeList) {
    const fa = fwd.get(e.source); if (fa) fa.push(e.target); else fwd.set(e.source, [e.target]);
    const ba = bwd.get(e.target); if (ba) ba.push(e.source); else bwd.set(e.target, [e.source]);
  }

  const nodes    = new Set<string>();
  const edgeKeys = new Set<string>();

  function bfs(startId: string, adj: Map<string, string[]>, forward: boolean) {
    nodes.add(startId);
    const queue = [startId];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      for (const nb of adj.get(cur) ?? []) {
        const key = forward ? `${cur}=>${nb}` : `${nb}=>${cur}`;
        edgeKeys.add(key);
        if (!nodes.has(nb)) { nodes.add(nb); queue.push(nb); }
      }
    }
  }

  bfs(nodeId, fwd, true);   // descendants (and their edges)
  bfs(nodeId, bwd, false);  // ancestors   (and their edges)

  return { nodes, edgeKeys };
}
