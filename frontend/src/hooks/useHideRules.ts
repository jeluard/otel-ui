import { useState, useCallback } from 'react';
import {
  hiddenRules,
  addHideRule,
  removeHideRule,
  resetHideRulesToDefaults,
  getHiddenInstances,
  toggleHiddenInstance as _toggleHiddenInstance,
  clearHiddenInstances as _clearHiddenInstances,
  type HideRule,
} from '../panels/hide-rules.ts';

export interface HideRulesApi {
  rules: HideRule[];
  /** Version counter — increment means rules changed. Use as a dependency / key. */
  version: number;
  hiddenInstances: Set<string>;
  add: (rule: HideRule) => void;
  remove: (index: number) => void;
  reset: () => Promise<void>;
  toggleInstance: (id: string) => void;
  clearInstances: () => void;
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

  const toggleInstance = useCallback((id: string) => {
    _toggleHiddenInstance(id);
    bump();
  }, []);

  const clearInstances = useCallback(() => {
    _clearHiddenInstances();
    bump();
  }, []);

  return { rules: hiddenRules, version, hiddenInstances: getHiddenInstances(), add, remove, reset, toggleInstance, clearInstances };
}
