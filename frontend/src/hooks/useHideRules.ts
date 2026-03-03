// ── useHideRules: React hook wrapping the module-level hiddenRules array ─────
// The module array is the ground truth; the version counter drives React re-renders.

import { useState, useCallback } from 'react';
import {
  hiddenRules,
  addHideRule,
  removeHideRule,
  resetHideRulesToDefaults,
  getInstanceFilter,
  setInstanceFilter as _setInstanceFilter,
  type HideRule,
} from '../panels/hide-rules.ts';

export interface HideRulesApi {
  rules: HideRule[];
  /** Version counter — increment means rules changed. Use as a dependency / key. */
  version: number;
  instanceFilter: string;
  add: (rule: HideRule) => void;
  remove: (index: number) => void;
  reset: () => Promise<void>;
  setInstance: (v: string) => void;
}

export function useHideRules(): HideRulesApi {
  // version-counter triggers re-renders without needing to copy the array
  const [version, setVersion] = useState(0);
  const bump = () => setVersion(v => v + 1);

  const add = useCallback((rule: HideRule) => {
    addHideRule(rule);
    bump();
  }, []);

  const remove = useCallback((index: number) => {
    removeHideRule(index);
    bump();
  }, []);

  const reset = useCallback(async () => {
    await resetHideRulesToDefaults();
    bump();
  }, []);

  const setInstance = useCallback((v: string) => {
    _setInstanceFilter(v);
    bump();
  }, []);

  return { rules: hiddenRules, version, instanceFilter: getInstanceFilter(), add, remove, reset, setInstance };
}
