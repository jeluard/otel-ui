// ── Demo mode: generates representative trace data for preview ─────────────

import type { WsMessage, Node, SpanEvent, Edge, TraceComplete } from './types.ts';

const SERVICE_TYPES = ['api', 'auth', 'database', 'cache', 'queue', 'worker'] as const;
type ServiceType = (typeof SERVICE_TYPES)[number];

const DEMO_SPANS: Record<ServiceType, string[]> = {
  api:      ['receive_request', 'validate_token', 'route_handler', 'send_response'],
  auth:     ['verify_token', 'check_permissions', 'log_access'],
  database: ['open_connection', 'execute_query', 'fetch_results', 'close_connection'],
  cache:    ['check_key', 'get_value', 'set_value'],
  queue:    ['enqueue_job', 'dequeue_job', 'process_job'],
  worker:   ['initialize', 'process_task', 'report_result'],
};

interface ServiceInstance { id: string; type: ServiceType; }

// Set once per topology generation; trace generation reuses the same node IDs
let demoInstances: ServiceInstance[] = SERVICE_TYPES.map(t => ({ id: t, type: t }));

function randomChoice<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randomId(prefix = ''): string {
  return prefix + Math.random().toString(36).slice(2, 11);
}

function randomDuration(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min) + min);
}

/**
 * Build per-tier instance arrays.
 * api always has 1 instance; other service types get 1–3 at random.
 */
function buildInstances(numTiers: number): ServiceInstance[][] {
  const tiers: ServiceInstance[][] = [];
  for (let t = 0; t < numTiers; t++) {
    const type  = SERVICE_TYPES[t];
    const count = type === 'api' ? 1 : Math.floor(Math.random() * 3) + 1;
    const tier: ServiceInstance[] = [];
    for (let i = 1; i <= count; i++) {
      tier.push({ id: count === 1 ? type : `${type}-${i}`, type });
    }
    tiers.push(tier);
  }
  return tiers;
}

function generateTrace(traceId: string): TraceComplete {
  const spans: SpanEvent[] = [];
  const traceStartNano = Date.now() * 1e6;
  // ~10% outlier traces to populate higher latency buckets in the heatmap
  const isOutlier = Math.random() < 0.10;
  const totalDurationNs = isOutlier
    ? randomDuration(150_000_000, 1_500_000_000) // 150ms–1.5s
    : randomDuration(20_000_000, 80_000_000);   // 20–80ms

  function addSpan(
    parentId: string | null,
    instanceId: string,
    startNs: number,
    durationNs: number,
    depth: number,
    maxDepth: number,
  ): void {
    const spanId   = randomId(`span_${instanceId}_`);
    const inst     = demoInstances.find(i => i.id === instanceId);
    const type     = inst?.type ?? 'api';
    const spanName = randomChoice(DEMO_SPANS[type]);

    spans.push({
      span_id:              spanId,
      trace_id:             traceId,
      parent_span_id:       parentId,
      target:               `${type}::${spanName}`,
      name:                 spanName,
      start_time_unix_nano: startNs,
      end_time_unix_nano:   startNs + durationNs,
      duration_ms:          durationNs / 1e6,
      attributes:           [],
      status:               Math.random() > 0.95 ? 'ERROR' : 'OK',
      service_name:         instanceId,
    });

    if (depth >= maxDepth) return;

    // 1–3 children, randomly skip generating children ~20% of the time
    const childCount = Math.random() < 0.2 ? 0 : Math.floor(Math.random() * 3) + 1;
    if (childCount === 0) return;

    const PAD_NS  = 400_000; // 0.4ms each side inside parent
    const GAP_NS  = 200_000; // 0.2ms gap between siblings
    const budget  = durationNs - 2 * PAD_NS - GAP_NS * (childCount - 1);
    if (budget < childCount * 800_000) return; // not enough room

    // Random proportions so siblings have varied widths
    const weights   = Array.from({ length: childCount }, () => Math.random() + 0.3);
    const totalW    = weights.reduce((a, b) => a + b, 0);
    let cursor = startNs + PAD_NS;

    const others = demoInstances.filter(i => i.id !== instanceId);
    for (let i = 0; i < childCount; i++) {
      const childDuration = Math.max(800_000, Math.floor((weights[i] / totalW) * budget));
      const childInst     = randomChoice(others);
      addSpan(spanId, childInst.id, cursor, childDuration, depth + 1, maxDepth);
      cursor += childDuration + GAP_NS;
    }
  }

  const maxDepth = Math.floor(Math.random() * 2) + 2; // 2–3 levels
  const rootInst = demoInstances.find(i => i.type === 'api') ?? demoInstances[0];
  addSpan(null, rootInst.id, traceStartNano, totalDurationNs, 0, maxDepth);

  const sorted = spans.sort((a, b) => a.start_time_unix_nano - b.start_time_unix_nano);
  return {
    trace_id:       traceId,
    spans:          sorted,
    root_span_name: sorted[0]?.name || 'trace',
    duration_ms:    totalDurationNs / 1e6,
    started_at:     traceStartNano,
  };
}

/**
 * Generate a topology_snapshot with multiple instances per service type.
 * e.g. auth-1, auth-2, database-1, database-2, database-3, ...
 */
export function generateTopologySnapshot(): WsMessage {
  const numTiers = Math.floor(Math.random() * 3) + 4; // 4–6 tiers
  const tiers    = buildInstances(numTiers);
  demoInstances  = tiers.flat();

  const nodes: Node[] = demoInstances.map(inst => ({
    id:         inst.id,
    category:   inst.type, // base type for consistent per-service coloring
    label:      inst.id,
    span_count: 0,
  }));

  const edges: Edge[] = [];
  for (let t = 0; t < tiers.length - 1; t++) {
    const srcIds = tiers[t].map(n => n.id);
    const dstIds = tiers[t + 1].map(n => n.id);

    // Round-robin over srcs while iterating shuffled dsts ensures
    // every dst gets ≥1 incoming edge and every src gets ≥1 outgoing edge.
    const shuffled    = [...dstIds].sort(() => Math.random() - 0.5);
    const coveredSrcs = new Set<string>();
    for (let i = 0; i < shuffled.length; i++) {
      const src = srcIds[i % srcIds.length];
      edges.push({ source: src, target: shuffled[i], flow_count: Math.floor(Math.random() * 90) + 10 });
      coveredSrcs.add(src);
    }
    // Any src not yet covered gets a random outgoing edge
    for (const src of srcIds) {
      if (!coveredSrcs.has(src)) {
        edges.push({ source: src, target: randomChoice(dstIds), flow_count: Math.floor(Math.random() * 90) + 10 });
      }
    }
  }

  return { type: 'topology_snapshot', nodes, edges };
}

/**
 * Generate a trace_completed message with demo data.
 */
export function generateTraceCompleted(): { type: 'trace_completed'; trace: TraceComplete } {
  const trace = generateTrace(randomId('trace_'));
  return {
    type: 'trace_completed',
    trace,
  };
}

/**
 * Convert SpanEvent[] to SpanArrivedPayload[] for the spans_batch message.
 * Fills in routing fields (to_node / from_node) using service_name.
 */
function toSpansBatch(spans: SpanEvent[]): WsMessage {
  const spanServiceMap = new Map<string, string>();
  for (const s of spans) spanServiceMap.set(s.span_id, s.service_name);

  const payloads = spans.map(s => ({
    trace_id:             s.trace_id,
    span_id:              s.span_id,
    parent_span_id:       s.parent_span_id,
    name:                 s.name,
    target:               s.target,
    start_time_unix_nano: s.start_time_unix_nano,
    end_time_unix_nano:   s.end_time_unix_nano,
    duration_ms:          s.duration_ms,
    status:               s.status,
    service_name:         s.service_name,
    to_node:              s.service_name,
    from_node:            s.parent_span_id ? (spanServiceMap.get(s.parent_span_id) ?? null) : null,
    edge_latency_ms:      null,
  }));
  return { type: 'spans_batch', spans: payloads };
}

/**
 * Start demo mode: periodically emit topology and trace messages.
 * Calls onMessage with generated messages.
 */
export function startDemo(onMessage: (msg: WsMessage) => void): () => void {
  // Send initial topology
  onMessage(generateTopologySnapshot());

  function emitTrace() {
    const traceMsg = generateTraceCompleted();
    // Fire spans_batch first so nodes/edges animate, then complete the trace
    onMessage(toSpansBatch(traceMsg.trace.spans));
    onMessage(traceMsg);
  }

  // Send a first trace immediately, then ~20/s
  const firstTimeout = setTimeout(emitTrace, 100);
  const traceInterval = setInterval(emitTrace, 300);

  return () => {
    clearTimeout(firstTimeout);
    clearInterval(traceInterval);
  };
}
