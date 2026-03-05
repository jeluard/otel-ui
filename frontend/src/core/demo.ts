// ── Demo mode: generates representative trace data for preview ─────────────

import type { WsMessage, Node, SpanEvent, Edge, TraceComplete } from './types.ts';

export type DemoScenario = 'standard' | 'multi-instance';

const SERVICE_TYPES = ['api', 'auth', 'database', 'cache', 'queue', 'worker', 'storage', 'monitor'] as const;
type ServiceType = (typeof SERVICE_TYPES)[number];

// Strict tier ordering — children must come from a deeper tier so span-derived
// edges always go forward and the history topology forms a proper DAG.
// Tiers 0–5 map to maxDepth 1–6 in the demo config.
const SERVICE_TIER: Record<ServiceType, number> = {
  api: 0, auth: 1, queue: 1, database: 2, cache: 2, worker: 3, storage: 4, monitor: 5,
};

const DEMO_SPANS: Record<ServiceType, string[]> = {
  api:      ['receive_request', 'validate_token', 'route_handler', 'send_response'],
  auth:     ['verify_token', 'check_permissions', 'log_access'],
  database: ['open_connection', 'execute_query', 'fetch_results', 'close_connection'],
  cache:    ['check_key', 'get_value', 'set_value'],
  queue:    ['enqueue_job', 'dequeue_job', 'process_job'],
  worker:   ['initialize', 'process_task', 'report_result'],
  storage:  ['upload_object', 'download_object', 'delete_object', 'list_objects'],
  monitor:  ['record_metric', 'flush_buffer', 'aggregate_stats', 'emit_event'],
};

interface ServiceInstance { id: string; type: ServiceType; }

// Set once per topology generation; trace generation reuses the same node IDs
let demoInstances: ServiceInstance[] = SERVICE_TYPES.map(t => ({ id: t, type: t }));

// ── Live-configurable demo parameters ────────────────────────────────────────

export interface DemoConfig {
  tracesPerSec: number;  // 0.5 – 10
  maxDepth:     number;  // 1 – 6  (span tree depth)
  maxFanout:    number;  // 1 – 5  (max children per span)
  errorRate:    number;  // 0.0 – 1.0
  outlierRate:  number;  // 0.0 – 1.0  (slow 150ms–1.5s traces)
}

export const DEFAULT_DEMO_CONFIG: DemoConfig = {
  tracesPerSec: 3.3,
  maxDepth:     3,
  maxFanout:    3,
  errorRate:    0.05,
  outlierRate:  0.10,
};

let _cfg: DemoConfig = { ...DEFAULT_DEMO_CONFIG };
let _liveIntervalId: ReturnType<typeof setInterval> | null = null;
let _liveEmitFn:     (() => void) | null = null;
let _liveOnMessage:  ((msg: WsMessage) => void) | null = null;
let _liveScenario:   DemoScenario = 'standard';
let _miWorkerCount:  number = 2; // preserved across depth changes

/** Update demo config live. Restarts the emission interval when tracesPerSec changes.
 *  Re-emits topology when depth changes (tier for standard, sub-services for multi-instance). */
export function setDemoConfig(next: DemoConfig): void {
  const prevMs    = Math.round(1000 / _cfg.tracesPerSec);
  const nextMs    = Math.round(1000 / next.tracesPerSec);
  const prevDepth = _cfg.maxDepth;
  _cfg = { ...next };
  if (prevMs !== nextMs && _liveEmitFn !== null && _liveIntervalId !== null) {
    clearInterval(_liveIntervalId);
    _liveIntervalId = setInterval(_liveEmitFn, nextMs);
  }
  if (prevDepth !== next.maxDepth && _liveOnMessage !== null) {
    if (_liveScenario === 'multi-instance') {
      _liveOnMessage(buildMultiInstanceTopology(_miWorkerCount, next.maxDepth));
    } else {
      const prevTier = Math.min(prevDepth - 1, 5);
      const nextTier = Math.min(next.maxDepth - 1, 5);
      if (prevTier !== nextTier) {
        _liveOnMessage(generateTopologyForDepth(next.maxDepth));
      }
    }
  }
}

function randomChoice<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randomId(prefix = ''): string {
  return prefix + Math.random().toString(36).slice(2, 11);
}

function randomDuration(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min) + min);
}

function generateTrace(traceId: string, startNs?: number, tiered = false): TraceComplete {
  const spans: SpanEvent[] = [];
  const traceStartNano = startNs ?? Date.now() * 1e6;
  // ~10% outlier traces to populate higher latency buckets in the heatmap
  const isOutlier = Math.random() < _cfg.outlierRate;
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
      target:               instanceId,
      name:                 spanName,
      start_time_unix_nano: startNs,
      end_time_unix_nano:   startNs + durationNs,
      duration_ms:          durationNs / 1e6,
      attributes:           [],
      status:               Math.random() < _cfg.errorRate ? 'ERROR' : 'OK',
      service_name:         instanceId,
      instance_id:          instanceId,
    });

    if (depth >= maxDepth) return;

    // 1–3 children, randomly skip generating children ~20% of the time
    const childCount = Math.random() < 0.2 ? 0 : Math.floor(Math.random() * _cfg.maxFanout) + 1;
    if (childCount === 0) return;

    const PAD_NS  = 400_000; // 0.4ms each side inside parent
    const GAP_NS  = 200_000; // 0.2ms gap between siblings
    const budget  = durationNs - 2 * PAD_NS - GAP_NS * (childCount - 1);
    if (budget < childCount * 800_000) return; // not enough room

    // Random proportions so siblings have varied widths
    const weights   = Array.from({ length: childCount }, () => Math.random() + 0.3);
    const totalW    = weights.reduce((a, b) => a + b, 0);
    let cursor = startNs + PAD_NS;

    // In tiered mode children must come from a strictly deeper tier so edges
    // always go forward — this guarantees a DAG with clear BFS roots.
    const myTier = SERVICE_TIER[type] ?? 0;
    const others = tiered
      ? demoInstances.filter(i => (SERVICE_TIER[i.type] ?? 0) > myTier)
      : demoInstances.filter(i => i.id !== instanceId);
    if (others.length === 0) return; // no deeper tier available
    for (let i = 0; i < childCount; i++) {
      const childDuration = Math.max(800_000, Math.floor((weights[i] / totalW) * budget));
      const childInst     = randomChoice(others);
      addSpan(spanId, childInst.id, cursor, childDuration, depth + 1, maxDepth);
      cursor += childDuration + GAP_NS;
    }
  }

  const maxDepth = _cfg.maxDepth;
  const rootInst = demoInstances.find(i => i.type === 'api') ?? demoInstances[0];
  addSpan(null, rootInst.id, traceStartNano, totalDurationNs, 0, maxDepth);

  const sorted = spans.sort((a, b) => a.start_time_unix_nano - b.start_time_unix_nano);
  return {
    trace_id:       traceId,
    spans:          sorted,
    root_span_name: sorted[0]?.name || 'trace',
    duration_ms:    totalDurationNs / 1e6,
    started_at:     traceStartNano,
    instance_id:    rootInst.id,
  };
}

/**
 * Build a topology_snapshot containing only the service tiers reachable at
 * the given maxDepth, using SERVICE_TIER for consistent tier assignment.
 *   maxDepth 1 → api only
 *   maxDepth 2 → + auth / queue (tier 1)
 *   maxDepth 3 → + database / cache (tier 2)
 *   maxDepth 4 → + worker (tier 3)
 *   maxDepth 5 → + storage (tier 4)
 *   maxDepth 6 → + monitor (tier 5, all services)
 */
function generateTopologyForDepth(maxDepth: number): WsMessage {
  const maxTier = Math.min(maxDepth - 1, 5);

  // Group service types by their SERVICE_TIER value
  // Fixed counts per service type keep node IDs stable across re-emits so that
  // depth changes show clear additions/removals rather than ID churn.
  const INSTANCE_COUNT: Record<ServiceType, number> = {
    api: 1, auth: 1, queue: 1, database: 2, cache: 1, worker: 2, storage: 1, monitor: 1,
  };

  const tierGroups = new Map<number, ServiceInstance[]>();
  for (const type of SERVICE_TYPES) {
    const tier = SERVICE_TIER[type];
    if (tier > maxTier) continue;
    if (!tierGroups.has(tier)) tierGroups.set(tier, []);
    const count = INSTANCE_COUNT[type];
    for (let i = 1; i <= count; i++) {
      tierGroups.get(tier)!.push({ id: count === 1 ? type : `${type}-${i}`, type });
    }
  }

  const tiers = [...tierGroups.keys()].sort((a, b) => a - b).map(t => tierGroups.get(t)!);
  demoInstances = tiers.flat();

  const nodes: Node[] = demoInstances.map(inst => ({
    id:         inst.id,
    category:   inst.type,
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
    for (const src of srcIds) {
      if (!coveredSrcs.has(src)) {
        edges.push({ source: src, target: randomChoice(dstIds), flow_count: Math.floor(Math.random() * 90) + 10 });
      }
    }
  }

  return { type: 'topology_snapshot', nodes, edges };
}

/** Full-topology snapshot (all service tiers). Used for history-mode seeding. */
export function generateTopologySnapshot(): WsMessage {
  return generateTopologyForDepth(6);
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
    instance_id:          s.instance_id,
    to_node:              s.service_name,
    from_node:            s.parent_span_id ? (spanServiceMap.get(s.parent_span_id) ?? null) : null,
    edge_latency_ms:      null,
  }));
  return { type: 'spans_batch', spans: payloads };
}

/**
 * Generate demo traces distributed across [from_ns, to_ns] for history mode.
 */
export function generateDemoHistoryTraces(from_ns: number, to_ns: number, count: number): TraceComplete[] {
  const span = Math.max(1, to_ns - from_ns);
  const traces: TraceComplete[] = [];
  for (let i = 0; i < count; i++) {
    const startNs = from_ns + Math.floor(Math.random() * span);
    traces.push(generateTrace(randomId('trace_'), startNs, true));
  }
  return traces.sort((a, b) => a.started_at - b.started_at);
}

// ── Multi-instance demo scenario ─────────────────────────────────────────────
// Simulates several parallel worker instances processing the same "block".
// All workers share one trace_id (derived from the block hash) and carry
// distinct instance_id values so the flamegraph shows them in parallel lanes.

const MI_COORD     = 'instance.0';
const MI_WORKERS   = ['instance.1', 'instance.2', 'instance.3', 'instance.4'];

/**
 * Build a multi-instance topology snapshot.
 * Worker count is fixed per session; sub-services are added based on depth:
 *   depth 1–2  → coordinator + workers only
 *   depth 3–4  → + database-1, database-2, cache
 *   depth 5–6  → + storage, monitor
 */
function buildMultiInstanceTopology(workerCount: number, depth: number): WsMessage {
  const activeWorkers = MI_WORKERS.slice(0, workerCount);

  // Sub-services visible as call targets (deeper tiers unlock with depth).
  const subInstances: ServiceInstance[] = [];
  if (depth >= 3) {
    subInstances.push(
      { id: 'database-1', type: 'database' as ServiceType },
      { id: 'database-2', type: 'database' as ServiceType },
      { id: 'cache',      type: 'cache'    as ServiceType },
    );
  }
  if (depth >= 5) {
    subInstances.push(
      { id: 'storage', type: 'storage' as ServiceType },
      { id: 'monitor', type: 'monitor' as ServiceType },
    );
  }

  demoInstances = [
    { id: MI_COORD, type: 'api' as ServiceType },
    ...activeWorkers.map(w => ({ id: w, type: 'worker' as ServiceType })),
    ...subInstances,
  ];

  // Diagram nodes use service names (matching span.service_name / to_node),
  // not instance IDs.  All worker instances share a single 'worker' node.
  const subServiceTypes = [...new Set(subInstances.map(s => s.type))];
  const nodes: Node[] = [
    { id: 'block_processor', category: 'api',    label: 'block_processor', span_count: 0 },
    { id: 'worker',          category: 'worker', label: 'worker',          span_count: 0 },
    ...subServiceTypes.map(t => ({ id: t, category: t, label: t, span_count: 0 })),
  ];

  const edges: Edge[] = [
    { source: 'block_processor', target: 'worker',
      flow_count: Math.floor(Math.random() * 90) + 10 },
    ...subServiceTypes.map(t => ({
      source: 'worker', target: t,
      flow_count: Math.floor(Math.random() * 50) + 5,
    })),
  ];

  return { type: 'topology_snapshot', nodes, edges };
}

function generateMultiInstanceTopology(): WsMessage {
  _miWorkerCount = Math.floor(Math.random() * 3) + 2; // 2–4, random, fixed for session
  return buildMultiInstanceTopology(_miWorkerCount, _cfg.maxDepth);
}

/**
 * Generate a single multi-instance trace: one trace_id shared across all active
 * workers, with each worker contributing child spans under a common coordinator
 * root span.  This mirrors the production model where deterministic trace IDs
 * are derived from the processed block hash.
 */
function generateMultiInstanceTrace(): TraceComplete {
  const activeWorkerIds = demoInstances.filter(i => i.type === 'worker').map(i => i.id);
  if (activeWorkerIds.length === 0) return generateTrace(randomId('trace_'));

  const traceId     = randomId('block_');
  const now         = Date.now() * 1e6;
  const isOutlier   = Math.random() < _cfg.outlierRate;
  const totalDurNs  = isOutlier
    ? randomDuration(150_000_000, 1_500_000_000)
    : randomDuration(20_000_000, 80_000_000);

  const spans: SpanEvent[] = [];

  // Root span: coordinator
  const rootSpanId = randomId('span_coord_');
  spans.push({
    span_id:              rootSpanId,
    trace_id:             traceId,
    parent_span_id:       null,
    target:               'block_processor',
    name:                 'process_block',
    start_time_unix_nano: now,
    end_time_unix_nano:   now + totalDurNs,
    duration_ms:          totalDurNs / 1e6,
    attributes:           [],
    status:               Math.random() < _cfg.errorRate ? 'ERROR' : 'OK',
    service_name:         'block_processor',
    instance_id:          MI_COORD,
  });

  // Each worker contributes a parallel child span tree.
  // Workers start at roughly the same time (small random jitter) so they
  // overlap in the flamegraph and look visually parallel.
  const PAD_NS    = 500_000;
  const workerDur = Math.max(1_000_000, totalDurNs - 2 * PAD_NS);
  const jitterNs  = Math.floor(workerDur * 0.15); // up to ±15% jitter

  for (let i = 0; i < activeWorkerIds.length; i++) {
    const workerId  = activeWorkerIds[i];
    const jitter    = Math.floor((Math.random() - 0.5) * 2 * jitterNs);
    const wStart    = now + PAD_NS + jitter;
    const wDur      = Math.max(1_000_000,
      workerDur - PAD_NS + Math.floor((Math.random() - 0.5) * jitterNs));
    const workerSpanId = randomId(`span_${workerId}_`);
    const subServices = demoInstances.filter(inst =>
      inst.type !== 'api' && inst.type !== 'worker'
    );

    spans.push({
      span_id:              workerSpanId,
      trace_id:             traceId,
      parent_span_id:       rootSpanId,
      target:               'worker',
      name:                 'execute',
      start_time_unix_nano: wStart,
      end_time_unix_nano:   wStart + wDur,
      duration_ms:          wDur / 1e6,
      attributes:           [],
      status:               Math.random() < _cfg.errorRate ? 'ERROR' : 'OK',
      service_name:         'worker',
      instance_id:          workerId,
    });

    // Optional sub-service calls from each worker
    if (subServices.length > 0 && _cfg.maxDepth >= 3) {
      const sub  = randomChoice(subServices);
      const sDur = Math.floor(wDur * 0.4);
      const sOff = Math.floor(wDur * 0.1);
      spans.push({
        span_id:              randomId(`span_${sub.id}_`),
        trace_id:             traceId,
        parent_span_id:       workerSpanId,
        target:               sub.type,
        name:                 randomChoice(DEMO_SPANS[sub.type] ?? ['call']),
        start_time_unix_nano: wStart + sOff,
        end_time_unix_nano:   wStart + sOff + sDur,
        duration_ms:          sDur / 1e6,
        attributes:           [],
        status:               Math.random() < _cfg.errorRate ? 'ERROR' : 'OK',
        service_name:         sub.type,
        instance_id:          workerId,
      });
    }
  }

  spans.sort((a, b) => a.start_time_unix_nano - b.start_time_unix_nano);
  return {
    trace_id:       traceId,
    spans,
    root_span_name: 'process_block',
    duration_ms:    totalDurNs / 1e6,
    started_at:     now,
    instance_id:    MI_COORD,
  };
}

/**
 * Multi-instance demo scenario: emits a single trace_completed per "block"
 * where all worker spans share the same trace_id and carry distinct instance_id
 * values.  This matches the production model of deterministic trace IDs derived
 * from a block hash.
 */
function startMultiInstanceDemo(onMessage: (msg: WsMessage) => void): () => void {
  _liveScenario  = 'multi-instance';
  _liveOnMessage = onMessage;
  onMessage(generateMultiInstanceTopology());

  function emitBlock() {
    const trace = generateMultiInstanceTrace();
    // Emit spans grouped by instance so each instance's batch arrives separately.
    const instOrder: string[] = [];
    const byInst = new Map<string, SpanEvent[]>();
    for (const s of trace.spans) {
      const iid = s.instance_id ?? '';
      if (!byInst.has(iid)) { byInst.set(iid, []); instOrder.push(iid); }
      byInst.get(iid)!.push(s);
    }
    for (const iid of instOrder) onMessage(toSpansBatch(byInst.get(iid)!));
    onMessage({ type: 'trace_completed', trace });
  }

  const intervalMs    = Math.round(1000 / _cfg.tracesPerSec);
  const firstTimeout  = setTimeout(emitBlock, 100);
  const blockInterval = setInterval(emitBlock, intervalMs);
  _liveIntervalId = blockInterval;
  _liveEmitFn     = emitBlock;

  return () => {
    clearTimeout(firstTimeout);
    clearInterval(blockInterval);
    _liveIntervalId = null;
    _liveEmitFn     = null;
    _liveOnMessage  = null;
    _liveScenario   = 'standard';
  };
}

/**
 * Start demo mode: periodically emit topology and trace messages.
 * Calls onMessage with generated messages.
 */
export function startDemo(onMessage: (msg: WsMessage) => void, scenario: DemoScenario = 'standard'): () => void {
  if (scenario === 'multi-instance') return startMultiInstanceDemo(onMessage);
  _liveScenario  = 'standard';
  _liveOnMessage = onMessage;
  // Send initial topology sized to the current depth config
  onMessage(generateTopologyForDepth(_cfg.maxDepth));

  function emitTrace() {
    const traceMsg = generateTraceCompleted();
    // Fire spans_batch first so nodes/edges animate, then complete the trace
    onMessage(toSpansBatch(traceMsg.trace.spans));
    onMessage(traceMsg);
  }

  const intervalMs   = Math.round(1000 / _cfg.tracesPerSec);
  const firstTimeout = setTimeout(emitTrace, 100);
  const traceInterval = setInterval(emitTrace, intervalMs);
  _liveIntervalId = traceInterval;
  _liveEmitFn     = emitTrace;

  return () => {
    clearTimeout(firstTimeout);
    clearInterval(traceInterval);
    _liveIntervalId = null;
    _liveEmitFn     = null;
    _liveOnMessage  = null;
    _liveScenario   = 'standard';
  };
}
