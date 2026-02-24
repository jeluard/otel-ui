A real-time OTel UI providing insights of what is going on inside your process.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  otel-ui/                                                 │
│                                                          │
│  ┌──────────────────┐   OTLP gRPC   ┌─────────────────┐ │
│  │  OTEL Collector  │──────────────▶│  Rust Backend   │ │
│  │  (port 4317/18)  │               │  (port 8080)    │ │
│  └──────────────────┘               │                 │ │
│           ▲                         │  • OTLP gRPC    │ │
│           │ spans                   │    receiver     │ │
│    Remote process                   │  • Span grouper │ │
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

## Development

```bash
# One-command dev mode
make dev

# Or individually:
make dev-backend   # Rust backend on :8080
make dev-frontend  # esbuild dev server on :3000
```

Override the WebSocket endpoint at runtime via the URL hash:
```
http://localhost:3000#ws=ws://localhost:8080
```
