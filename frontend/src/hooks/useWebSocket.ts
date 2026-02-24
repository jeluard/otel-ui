// ── useWebSocket: lifecycle hook for WsClient ────────────────────────────────

import { useEffect, useRef } from 'react';
import { WsClient } from '../core/ws-client.ts';
import type { WsMessage } from '../core/types.ts';

interface UseWebSocketOptions {
  url: string;
  onMessage: (msg: WsMessage) => void;
  onStatus: (connected: boolean) => void;
}

/** Starts and manages a WsClient instance. Reconnects automatically. */
export function useWebSocket({ url, onMessage, onStatus }: UseWebSocketOptions): void {
  // Stable refs so we never need to restart the client when callbacks change
  const onMessageRef = useRef(onMessage);
  const onStatusRef  = useRef(onStatus);
  useEffect(() => { onMessageRef.current = onMessage; }, [onMessage]);
  useEffect(() => { onStatusRef.current  = onStatus;  }, [onStatus]);

  useEffect(() => {
    const client = new WsClient(
      url,
      (msg) => onMessageRef.current(msg),
      (connected) => onStatusRef.current(connected),
    );
    client.start();
    return () => client.destroy();
  }, [url]);
}
