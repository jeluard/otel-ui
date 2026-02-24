// ── HideRulesDialog: manage span-filtering rules ─────────────────────────────

import React, { useState, useCallback } from 'react';
import type { HideRule } from '../panels/hide-rules.ts';
import { useHideRules } from '../hooks/useHideRules.ts';

interface HideRulesDialogProps {
  open: boolean;
  onClose: () => void;
}

function HideRulesDialog({ open, onClose }: HideRulesDialogProps) {
  const { rules, add, remove, reset } = useHideRules();
  const [target, setTarget] = useState('');
  const [name,   setName  ] = useState('');

  const handleAdd = useCallback(() => {
    const t = target.trim();
    const n = name.trim();
    if (!t && !n) return;
    add({ target: t || undefined, name: n || undefined } as HideRule);
    setTarget('');
    setName('');
  }, [target, name, add]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => { if (e.key === 'Enter') handleAdd(); },
    [handleAdd],
  );

  if (!open) return null;

  return (
    <div id="hide-dialog-overlay" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div id="hide-dialog" role="dialog" aria-modal="true" aria-label="Hide Rules">
        <div id="hide-dialog-header">
          <span id="hide-dialog-title">Hide Rules</span>
          <button id="hide-dialog-close" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div id="hide-dialog-help">
          Spans matching <em>any</em> rule are excluded from flamegraphs and span tables.
          Leave a field blank to match any value.
        </div>

        {/* Existing rules */}
        <div id="hide-dialog-rules">
          {rules.length === 0 ? (
            <div className="hide-dialog-empty">No rules — all spans are visible.</div>
          ) : (
            <>
              <div className="hide-rule-header">
                <span className="hide-rule-header-cell">Target</span>
                <span className="hide-rule-header-cell">Name</span>
                <span className="hide-rule-header-cell" />
              </div>
              {rules.map((rule, i) => (
                <div key={i} className="hide-rule-row">
                  <span className="hide-rule-label">{rule.target || <em>any</em>}</span>
                  <span className="hide-rule-label">{rule.name   || <em>any</em>}</span>
                  <button
                    className="hide-rule-remove"
                    title="Remove rule"
                    onClick={() => remove(i)}
                  >✕</button>
                </div>
              ))}
            </>
          )}
        </div>

        {/* Add new rule */}
        <div id="hide-dialog-add">
          <input
            id="hide-rule-target"
            type="text"
            placeholder="target (optional)"
            value={target}
            onChange={e => setTarget(e.target.value)}
            onKeyDown={handleKeyDown}
            aria-label="Target filter"
          />
          <input
            id="hide-rule-name"
            type="text"
            placeholder="span name (optional)"
            value={name}
            onChange={e => setName(e.target.value)}
            onKeyDown={handleKeyDown}
            aria-label="Span name filter"
          />
          <button id="hide-rule-add" onClick={handleAdd} disabled={!target.trim() && !name.trim()}>
            Add Rule
          </button>
        </div>

        {/* Footer */}
        <div id="hide-dialog-footer">
          <button id="hide-rules-reset" onClick={reset}>Reset to defaults</button>
        </div>
      </div>
    </div>
  );
}

export default HideRulesDialog;
