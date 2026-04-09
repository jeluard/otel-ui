A real-time OTel UI providing insights of what is going on inside your process.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  otel-ui/                                                 │
│                                                          │
│  ┌──────────────────┐  OTLP gRPC    ┌─────────────────┐ │
│  │  OTEL Collector  │──────────────▶│  Rust Backend   │ │
│  │  gRPC  port 4317 │  OTLP HTTP    │  (port 8080)    │ │
│  │  HTTP  port 4318 │──────────────▶│                 │ │
│  └──────────────────┘               │  • OTLP gRPC    │ │
│           ▲                         │    receiver     │ │
│           │ spans/metrics           │  • OTLP HTTP    │ │
│    Remote process                   │    receiver     │ │
│                                     │  • Span grouper │ │
│                                     │  • WebSocket    │ │
│                                     │    broadcaster  │ │
│                                     └────────┬────────┘ │
│                                              │ WS /ws   │
│                                     ┌────────▼────────┐ │
│                                     │  Browser UI     │ │
│                                     │                 │ │
│                                     └─────────────────┘ │
└─────────────────────────────────────────────────────────┘
```

### Components

| Service | Description |
|---|---|
| `collector/` | OpenTelemetry Collector config — receives spans via gRPC/HTTP, batches and forwards to the backend |
| `backend/` | Rust service that implements an OTLP gRPC server + WebSocket broadcaster. Discovers topology dynamically from span parent-child links. |
| `frontend/` | esbuild + TypeScript canvas app |

## Quick Start

### Running the backend via Docker

The backend can be run without a local Rust toolchain using Docker. The image is published to the GitHub Container Registry on every push to `main`:

```bash
docker run --rm -p 4317:4317 -p 4318:4318 -p 8080:8080 ghcr.io/jeluard/otel-ui-bridge:latest
```

This exposes:
- `:4317` — OTLP gRPC endpoint (traces, logs)
- `:4318` — OTLP HTTP/protobuf endpoint (metrics)
- `:8080` — WebSocket + HTTP API for the UI

### Using the hosted UI

A hosted version of the frontend is available at [https://jeluard.github.io/otel-ui](https://jeluard.github.io/otel-ui). Point it at your local backend by appending the WebSocket URL to the hash:

```
https://jeluard.github.io/otel-ui#ws=ws://localhost:8080
```

No data leaves your machine — the browser connects directly to your local backend over WebSocket.

## Development

```bash
# One-command dev mode
make dev-all

# Or individually:
make dev-backend   # Rust backend on :8081
make dev-frontend  # esbuild dev server on :8080
```

Override the WebSocket endpoint at runtime via the URL hash:
```
http://localhost:3000#ws=ws://localhost:8080
```

## WebSocket API

The backend broadcasts all telemetry over a WebSocket at `ws://<host>/ws`.
Messages are newline-delimited JSON. Two message types are emitted:

### `spans_batch`

Emitted whenever a batch of spans is received from an instrumented process.

```ts
{
  type: "spans_batch",
  spans: Array<{
    trace_id:             string,       // hex trace ID
    span_id:              string,       // hex span ID
    parent_span_id:       string|null,  // null for root spans
    name:                 string,       // operation name
    target:               string,       // dotted module path, e.g. "module::sub"
    service_name:         string,
    instance_id?:         string,       // process/node instance
    start_time_unix_nano: number,
    end_time_unix_nano:   number,
    duration_ms:          number,
    status:               string,       // "ok" | "error" | "unset"
    attributes:           [string, string][]
  }>
}
```

### `metrics_batch`

Emitted whenever a batch of metric data points is received.

```ts
{
  type: "metrics_batch",
  metrics: Array<{
    service_name:        string,
    metric_name:         string,
    description:         string,
    unit:                string,
    timestamp_unix_nano: number,
    attributes:          [string, string][],
    value:
      | { kind: "gauge",     value: number }
      | { kind: "sum",       value: number, is_monotonic: boolean }
      | { kind: "histogram", count: number, sum: number, min: number, max: number }
  }>
}
```

### Reading data with plain JavaScript

```js
const ws = new WebSocket("ws://localhost:8081/ws");

ws.addEventListener("message", ({ data }) => {
  const msg = JSON.parse(data);

  if (msg.type === "spans_batch") {
    for (const span of msg.spans) {
      console.log(
        `[${span.service_name}] ${span.name}`,
        `${span.duration_ms.toFixed(1)} ms`,
        span.status === "error" ? "❌" : "✅"
      );
    }
  }

  if (msg.type === "metrics_batch") {
    for (const m of msg.metrics) {
      const val =
        m.value.kind === "histogram" ? m.value.sum / m.value.count  // average
        : m.value.value;
      console.log(`[${m.service_name}] ${m.metric_name} = ${val} ${m.unit}`);
    }
  }
});
```
