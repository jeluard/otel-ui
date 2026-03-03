// ── useWebSocket: lifecycle hook for WsClient ────────────────────────────────

import { useEffect, useRef } from 'react';
import { WsClient } from '../core/ws-client.ts';
import type { WsMessage } from '../core/types.ts';

interface UseWebSocketOptions {
  url: string;
  onMessage: (msg: WsMessage) => void;
  onStatus: (connected: boolean) => void;
}

/** Starts and manages a WsClient instance. Reconnects automatically.
 *  Returns a `sendMessage` function for sending text frames to the server. */
export function useWebSocket({ url, onMessage, onStatus }: UseWebSocketOptions): { sendMessage: (text: string) => void } {
  // Stable refs so we never need to restart the client when callbacks change
  const onMessageRef = useRef(onMessage);
  const onStatusRef  = useRef(onStatus);
  const clientRef    = useRef<WsClient | null>(null);
  useEffect(() => { onMessageRef.current = onMessage; }, [onMessage]);
  useEffect(() => { onStatusRef.current  = onStatus;  }, [onStatus]);

  useEffect(() => {
    const client = new WsClient(
      url,
      (msg) => onMessageRef.current(msg),
      (connected) => onStatusRef.current(connected),
    );
    clientRef.current = client;
    client.start();
    return () => { client.destroy(); clientRef.current = null; };
  }, [url]);

  return {
    sendMessage: (text: string) => clientRef.current?.send(text),
  };
}
