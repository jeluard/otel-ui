// ── CorrelationKeyDialog: configure correlation key preference ─────────────

import React, { useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';

interface CorrelationKeyDialogProps {
  open: boolean;
  onClose: () => void;
  serverKey: string | null;
  userPreference: string | null;
  onSave: (key: string | null) => void;
}

export default function CorrelationKeyDialog({
  open,
  onClose,
  serverKey,
  userPreference,
  onSave,
}: CorrelationKeyDialogProps) {
  const [inputValue, setInputValue] = useState('');

  // Sync input with current preference when dialog opens
  useEffect(() => {
    if (open) {
      setInputValue(userPreference || serverKey || 'block.hash');
    }
  }, [open, userPreference, serverKey]);

  const handleSave = useCallback(() => {
    const value = inputValue.trim();
    const isUsingDefault = value === (serverKey || 'block.hash');
    onSave(isUsingDefault ? null : value);
    onClose();
  }, [inputValue, serverKey, onSave, onClose]);

  const handleReset = useCallback(() => {
    onSave(null);
    onClose();
  }, [onSave, onClose]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleSave();
    } else if (e.key === 'Escape') {
      onClose();
    }
  };

  if (!open) return null;

  const defaultKey = serverKey || 'block.hash';
  const isDefault = inputValue.trim() === defaultKey;

  return createPortal(
    <div
      className="dialog-overlay"
      onClick={e => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="dialog-box" role="dialog" aria-modal="true" aria-label="Correlation Key Settings">
        <div className="dialog-header">
          <div>
            <div className="dialog-title">Correlation Key</div>
            <div className="dialog-subtitle">
              Attribute used to group traces across instances
            </div>
          </div>
          <button className="dialog-close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <div className="dialog-body">
          <div className="dialog-field">
            <label htmlFor="corr-key-input">Correlation Key Attribute:</label>
            <input
              id="corr-key-input"
              type="text"
              className="dialog-input"
              value={inputValue}
              onChange={e => setInputValue(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={defaultKey}
              autoFocus
            />
            {serverKey && (
              <div className="dialog-help">
                Server configured: <code>{serverKey}</code>
              </div>
            )}
            {!isDefault && userPreference && (
              <div className="dialog-help">
                Currently overridden from default
              </div>
            )}
          </div>
        </div>

        <div className="dialog-footer">
          {userPreference && (
            <button className="btn-secondary" onClick={handleReset}>
              Reset to Default
            </button>
          )}
          <button className="btn-primary" onClick={handleSave}>
            Save
          </button>
          <button className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
