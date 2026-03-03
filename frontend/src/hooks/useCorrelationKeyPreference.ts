// ── useCorrelationKeyPreference: manage user's correlation key preference ───

import { useState, useEffect } from 'react';

const PREF_STORAGE_KEY = 'otel-ui-correlation-key-pref';

interface CorrelationKeyConfig {
  serverConfiguredKey: string;
}

/**
 * Hook to manage the user's correlation key preference.
 * - Fetches the server-configured correlation key from /config endpoint
 * - Reads the user's saved preference from localStorage
 * - Provides methods to get and set the user's preference
 * - Returns effective preference (user override or server default)
 */
export function useCorrelationKeyPreference() {
  const [serverKey, setServerKey] = useState<string | null>(null);
  const [userPreference, setUserPreference] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Fetch server config on mount
  useEffect(() => {
    const fetchConfig = async () => {
      try {
        const response = await fetch('/config');
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const config = (await response.json()) as CorrelationKeyConfig;
        setServerKey(config.serverConfiguredKey || 'block.hash');
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        // Fall back to default
        setServerKey('block.hash');
      } finally {
        setLoading(false);
      }
    };

    fetchConfig();
  }, []);

  // Load user preference from localStorage on mount
  useEffect(() => {
    const saved = localStorage.getItem(PREF_STORAGE_KEY);
    if (saved) {
      setUserPreference(saved);
    }
  }, []);

  /**
   * Get the effective correlation key:
   * - Returns user preference if set
   * - Falls back to server-configured key
   * - Returns null if not yet loaded
   */
  const effectiveKey = userPreference || serverKey;

  /**
   * Set the user's correlation key preference.
   * Pass null or empty string to clear the preference and use server default.
   */
  const setPreference = (key: string | null) => {
    if (key && key.trim()) {
      const normalized = key.trim();
      setUserPreference(normalized);
      localStorage.setItem(PREF_STORAGE_KEY, normalized);
    } else {
      setUserPreference(null);
      localStorage.removeItem(PREF_STORAGE_KEY);
    }
  };

  return {
    serverKey,
    userPreference,
    effectiveKey,
    setPreference,
    loading,
    error,
  };
}
