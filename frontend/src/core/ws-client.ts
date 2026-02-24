// ── WebSocket connection manager ─────────────────────────────────────────────

import type { WsMessage } from './types.ts';

type MessageHandler = (msg: WsMessage) => void;
type StatusHandler = (connected: boolean) => void;

export class WsClient {
  private ws: WebSocket | null = null;
  private url: string;
  private onMessage: MessageHandler;
  private onStatus: StatusHandler;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 1000;

  constructor(url: string, onMessage: MessageHandler, onStatus: StatusHandler) {
    this.url = url;
    this.onMessage = onMessage;
    this.onStatus = onStatus;
    // Don't auto-connect; call start() explicitly so callers can await
    // any async initialisation (e.g. loading filter defaults) before the
    // first WebSocket message arrives.
  }

  /** Begin the WebSocket connection (and auto-reconnect loop). */
  start() {
    this.connect();
  }

  private connect() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    try {
      this.ws = new WebSocket(this.url);
    } catch {
      this.scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      this.reconnectDelay = 1000;
      this.onStatus(true);
    };

    this.ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data as string) as WsMessage;
        this.onMessage(msg);
      } catch {
        // ignore
      }
    };

    this.ws.onerror = () => {
      this.onStatus(false);
    };

    this.ws.onclose = () => {
      this.onStatus(false);
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectDelay = Math.min(this.reconnectDelay * 1.5, 10000);
      this.connect();
    }, this.reconnectDelay);
  }

  send(data: string) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(data);
    }
  }

  destroy() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.ws = null;
  }
}
