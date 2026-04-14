// ── Demo mode: generates representative trace data for preview ─────────────

import type { WsMessage, SpanEvent, TraceComplete, MetricEvent, LogEvent } from './types.ts';

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
  maxDepth:     4,
  maxFanout:    3,
  errorRate:    0.05,
  outlierRate:  0.10,
};

let _cfg: DemoConfig = { ...DEFAULT_DEMO_CONFIG };
let _liveIntervalId:     ReturnType<typeof setInterval> | null = null;
let _liveMetricsIntervalId: ReturnType<typeof setInterval> | null = null;
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
      buildMultiInstanceTopology(_miWorkerCount, next.maxDepth);
    } else {
      const prevTier = Math.min(prevDepth - 1, 5);
      const nextTier = Math.min(next.maxDepth - 1, 5);
      if (prevTier !== nextTier) {
        generateTopologyForDepth(next.maxDepth);
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

    // In tiered mode children must come from the immediately next tier so the
    // DAG has a clear column-per-tier structure in the layout.
    const myTier = SERVICE_TIER[type] ?? 0;
    const others = tiered
      ? demoInstances.filter(i => (SERVICE_TIER[i.type] ?? 0) === myTier + 1)
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
 * Update the set of active demo service instances for the given maxDepth.
 * Topology is no longer pre-seeded — the frontend builds it from spans.
 *   maxDepth 1 → api only
 *   maxDepth 2 → + auth / queue (tier 1)
 *   maxDepth 3 → + database / cache (tier 2)
 *   maxDepth 4 → + worker (tier 3)
 *   maxDepth 5 → + storage (tier 4)
 *   maxDepth 6 → + monitor (tier 5, all services)
 */
function generateTopologyForDepth(maxDepth: number): void {
  const maxTier = Math.min(maxDepth - 1, 5);

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

  demoInstances = [...tierGroups.keys()].sort((a, b) => a - b).flatMap(t => tierGroups.get(t)!);
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
 * Update demoInstances to reflect the multi-instance topology for the given
 * worker count and depth. Topology is built by the frontend from emitted spans.
 */
function buildMultiInstanceTopology(workerCount: number, depth: number): void {
  const activeWorkers = MI_WORKERS.slice(0, workerCount);

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
}

function generateMultiInstanceTopology(): void {
  _miWorkerCount = Math.floor(Math.random() * 3) + 2;
  buildMultiInstanceTopology(_miWorkerCount, _cfg.maxDepth);
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
  generateMultiInstanceTopology();

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
    for (const iid of instOrder) onMessage({ type: 'spans_batch', spans: byInst.get(iid)! });
  }

  const intervalMs    = Math.round(1000 / _cfg.tracesPerSec);
  const firstTimeout  = setTimeout(emitBlock, 100);
  const blockInterval = setInterval(emitBlock, intervalMs);
  _liveIntervalId = blockInterval;
  _liveEmitFn     = emitBlock;

  // Emit metrics and logs every 2 s
  const firstMetricsTimeout = setTimeout(() => emitDemoMetrics(onMessage), 500);
  const firstLogsTimeout    = setTimeout(() => emitDemoLogs(onMessage), 800);
  _liveMetricsIntervalId = setInterval(() => {
    emitDemoMetrics(onMessage);
    emitDemoLogs(onMessage);
  }, 2000);

  return () => {
    clearTimeout(firstTimeout);
    clearTimeout(firstMetricsTimeout);
    clearTimeout(firstLogsTimeout);
    clearInterval(blockInterval);
    if (_liveMetricsIntervalId !== null) { clearInterval(_liveMetricsIntervalId); _liveMetricsIntervalId = null; }
    _liveIntervalId = null;
    _liveEmitFn     = null;
    _liveOnMessage  = null;
    _liveScenario   = 'standard';
  };
}

// ── Demo metrics generation ───────────────────────────────────────────────
//
// Per-service state for realistic-looking metric trajectories.
// Each service has a slowly-drifting baseline with short spikes.

interface MetricState {
  cpu:         number;   // 0–100
  mem:         number;   // bytes
  reqRate:     number;   // req/s
  errorRate:   number;   // 0–1
  p99latency:  number;   // ms
  reqTotal:    number;   // monotonic counter
}

const _metricState = new Map<string, MetricState>();

function initialMetricState(id: string): MetricState {
  // Seed deterministically from service name so each service has a distinct baseline
  const seed = id.split('').reduce((a, c) => (a * 31 + c.charCodeAt(0)) & 0xfffff, 0);
  const frac = (seed & 0xffff) / 0xffff;
  return {
    cpu:        20 + frac * 40,
    mem:        50_000_000 + frac * 200_000_000,
    reqRate:    5  + frac * 30,
    errorRate:  0.005 + frac * 0.02,
    p99latency: 20  + frac * 160,
    reqTotal:   Math.floor(1000 + frac * 50_000),
  };
}

function drift(v: number, min: number, max: number, step: number): number {
  const d = (Math.random() - 0.48) * step;  // slight upward drift
  return Math.max(min, Math.min(max, v + d));
}

function emitDemoMetrics(onMessage: (msg: WsMessage) => void): void {
  const now = Date.now() * 1e6; // ns
  const batch: MetricEvent[] = [];

  // Occasionally inject a spike on one service (10% of ticks)
  const spikeTarget = Math.random() < 0.10
    ? demoInstances[Math.floor(Math.random() * demoInstances.length)]?.id ?? null
    : null;

  for (const inst of demoInstances) {
    let st = _metricState.get(inst.id);
    if (!st) { st = initialMetricState(inst.id); _metricState.set(inst.id, st); }

    const spiking = inst.id === spikeTarget;

    // Slowly drift all metrics
    st.cpu        = spiking ? Math.min(100, st.cpu + 30 * Math.random()) : drift(st.cpu, 5, 95, 8);
    st.mem        = drift(st.mem, 20_000_000, 500_000_000, 5_000_000);
    st.reqRate    = spiking ? st.reqRate * (1.5 + Math.random()) : drift(st.reqRate, 1, 200, 5);
    st.errorRate  = spiking ? Math.min(1, st.errorRate + 0.15) : drift(st.errorRate * 100, 0, 30, 1) / 100;
    st.p99latency = spiking ? st.p99latency * (2 + Math.random()) : drift(st.p99latency, 5, 2000, 20);
    st.reqTotal   = Math.round(st.reqTotal + st.reqRate * 2); // 2s tick

    const svc   = inst.id;
    const attrs: [string, string][] = [['service.instance.id', svc]];

    batch.push(
      // CPU gauge
      { service_name: svc, metric_name: 'process.cpu.usage',
        description: 'CPU usage %', unit: '%',
        timestamp_unix_nano: now, attributes: attrs,
        value: { kind: 'gauge', value: parseFloat(st.cpu.toFixed(1)) } },

      // Memory gauge
      { service_name: svc, metric_name: 'process.memory.usage',
        description: 'Resident memory bytes', unit: 'By',
        timestamp_unix_nano: now, attributes: attrs,
        value: { kind: 'gauge', value: Math.round(st.mem) } },

      // Request rate gauge
      { service_name: svc, metric_name: 'http.request.rate',
        description: 'Requests per second', unit: 'req/s',
        timestamp_unix_nano: now, attributes: attrs,
        value: { kind: 'gauge', value: parseFloat(st.reqRate.toFixed(2)) } },

      // Error rate gauge
      { service_name: svc, metric_name: 'http.error.rate',
        description: 'Fraction of requests that errored', unit: '1',
        timestamp_unix_nano: now, attributes: attrs,
        value: { kind: 'gauge', value: parseFloat(st.errorRate.toFixed(4)) } },

      // Request duration histogram (p99 approximated as a histogram)
      { service_name: svc, metric_name: 'http.request.duration',
        description: 'Request duration', unit: 'ms',
        timestamp_unix_nano: now, attributes: attrs,
        value: { kind: 'histogram', count: Math.round(st.reqRate * 2),
                 sum: st.p99latency * st.reqRate * 2 * 0.4,
                 min: 1,
                 max: parseFloat(st.p99latency.toFixed(1)) } },

      // Monotonic request counter
      { service_name: svc, metric_name: 'http.requests.total',
        description: 'Total requests handled', unit: 'req',
        timestamp_unix_nano: now, attributes: attrs,
        value: { kind: 'sum', value: st.reqTotal, is_monotonic: true } },
    );
  }

  if (batch.length > 0) onMessage({ type: 'metrics_batch', metrics: batch });
}

// ── Demo log generation ───────────────────────────────────────────────────────

const LOG_SEVERITY_LEVELS: { text: string; number: number }[] = [
  { text: 'DEBUG', number: 5 },
  { text: 'INFO',  number: 9 },
  { text: 'WARN',  number: 13 },
  { text: 'ERROR', number: 17 },
];

const LOG_MESSAGES: Record<ServiceType, string[]> = {
  api:      ['Request received', 'Request validated', 'Response sent', 'Rate limit check passed', 'Auth header missing'],
  auth:     ['Token verified', 'Permission granted', 'Invalid token', 'Session expired', 'Access denied'],
  database: ['Query executed', 'Connection acquired', 'Slow query detected', 'Index hit', 'Connection pool exhausted'],
  cache:    ['Cache hit', 'Cache miss', 'Key evicted', 'Cache warmed', 'TTL expired'],
  queue:    ['Job enqueued', 'Job dequeued', 'Queue depth high', 'Dead-letter queue updated', 'Job processed'],
  worker:   ['Task started', 'Task completed', 'Retry scheduled', 'Worker idle', 'Task failed'],
  storage:  ['Object uploaded', 'Object downloaded', 'Object deleted', 'Storage quota near limit', 'Transfer complete'],
  monitor:  ['Metric recorded', 'Alert triggered', 'Threshold exceeded', 'Stats aggregated', 'Health check passed'],
};

function emitDemoLogs(onMessage: (msg: WsMessage) => void): void {
  const now = Date.now() * 1e6;
  const logs: LogEvent[] = [];
  const count = Math.floor(Math.random() * 4) + 1;

  for (let i = 0; i < count; i++) {
    const inst = randomChoice(demoInstances);
    const isError = Math.random() < _cfg.errorRate * 2;
    const severity = isError
      ? LOG_SEVERITY_LEVELS[3]
      : randomChoice(LOG_SEVERITY_LEVELS.slice(0, 3));
    const messages = LOG_MESSAGES[inst.type] ?? ['log entry'];
    const body = randomChoice(messages);
    const jitterNs = Math.floor(Math.random() * 1_000_000_000);

    logs.push({
      timestamp_unix_nano: now - jitterNs,
      observed_unix_nano:  now,
      severity_text:       severity.text,
      severity_number:     severity.number,
      body,
      trace_id:            null,
      span_id:             null,
      attributes:          [['service.instance.id', inst.id]],
      service_name:        inst.id,
    });
  }

  onMessage({ type: 'logs_batch', logs });
}

/**
 * Start demo mode: periodically emit topology and trace messages.
 * Calls onMessage with generated messages.
 */
export function startDemo(onMessage: (msg: WsMessage) => void, scenario: DemoScenario = 'standard'): () => void {
  if (scenario === 'multi-instance') return startMultiInstanceDemo(onMessage);
  _liveScenario  = 'standard';
  _liveOnMessage = onMessage;
  generateTopologyForDepth(_cfg.maxDepth);

  function emitTrace() {
    const trace = generateTrace(randomId('trace_'), undefined, true);
    onMessage({ type: 'spans_batch', spans: trace.spans });
  }

  const intervalMs   = Math.round(1000 / _cfg.tracesPerSec);
  const firstTimeout = setTimeout(emitTrace, 100);
  const traceInterval = setInterval(emitTrace, intervalMs);
  _liveIntervalId = traceInterval;
  _liveEmitFn     = emitTrace;

  // Emit metrics and logs every 2 s
  const firstMetricsTimeout = setTimeout(() => emitDemoMetrics(onMessage), 500);
  const firstLogsTimeout    = setTimeout(() => emitDemoLogs(onMessage), 800);
  _liveMetricsIntervalId = setInterval(() => {
    emitDemoMetrics(onMessage);
    emitDemoLogs(onMessage);
  }, 2000);

  return () => {
    clearTimeout(firstTimeout);
    clearTimeout(firstMetricsTimeout);
    clearTimeout(firstLogsTimeout);
    clearInterval(traceInterval);
    if (_liveMetricsIntervalId !== null) { clearInterval(_liveMetricsIntervalId); _liveMetricsIntervalId = null; }
    _liveIntervalId = null;
    _liveEmitFn     = null;
    _liveOnMessage  = null;
    _liveScenario   = 'standard';
  };
}
