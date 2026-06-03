// createProgressModal: Eve-style busy modal: <dialog> with animated
// bar, two banner lines, growing row block, mode-aware cancel button.
// Layers on top of createModal (close-X + ESC + lifecycle live there).
//
// Close semantics specific to progress modals:
//   - In 'cancel' mode, first close-X/ESC aborts the run via the
//     AbortController and DOES NOT close the dialog (vetoed); a second
//     X/ESC after abort actually closes.
//   - In 'close' or 'done' mode, close-X/ESC closes immediately.
// Implemented via base.onRequestClose() (vetoable).
//
// ids: { dialog, title?, test?, detail?, bar?, rowsHost, cancelBtn?, closeX? }
//
// Returns:
//   signal           AbortSignal tied to the current open() call.
//   open(title?)     showModal; reset banner + rows + AbortController.
//   close()          finalClose (dialog.close + rows.clear).
//   update({test, detail}) write banner lines.
//   updateEta(text)  append "ETA …" to the detail line (throttled ≥1s).
//   rows             createLoadRowBlock instance backed by rowsHost.
//   setCancelMode(m) 'cancel' | 'close' | 'done', changes bottom-button.
//   showError(text)  sticky-error: clear rows, add error row, mode='close'.
//   done()           clear rows, mode='done' (flashing Done button).
//   onCancel(cb)     register a callback for the cancel pathway (bottom
//                    Cancel, top X, ESC, or programmatic .cancel()).
//   cancel()         fire the cancel pathway programmatically.
//   bar              progress element (escape hatch for live writes).
//
// Rule 26: textContent only.

import { createModal } from './modal.js';

const $ = (id) => document.getElementById(id);

// CSS.escape polyfill-ish for the attribute-selector path. Load rowIds
// may include parentheses and spaces (e.g. "texting-teen (vocab)").
// Falls back to a manual escape on older browsers that miss CSS.escape.
function cssEscape(s) {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return CSS.escape(s);
  }
  return String(s).replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);
}

// createLoadRowBlock(hostId) -> { clear, add, update, remove }
//
// Generic per-resource load-progress block. One row per active
// loadResource call, keyed by caller-chosen `id`. Rows materialize on
// add(), text-updates in place on update(), vanish on remove(). Host
// auto-hides when empty.
export function createLoadRowBlock(hostId) {
  const host = () => $(hostId);
  return {
    clear() {
      const h = host();
      if (!h) return;
      while (h.firstChild) h.removeChild(h.firstChild);
      h.hidden = true;
    },
    add(id, initialLabel, opts = {}) {
      const h = host();
      if (!h) return;
      let row = h.querySelector(`.eve-worker-row[data-load-id="${cssEscape(id)}"]`);
      if (!row) {
        row = document.createElement('div');
        row.className = 'eve-worker-row eve-worker-row-busy';
        if (opts.error) row.classList.add('progress-row-error');
        row.setAttribute('data-load-id', id);
        const idEl = document.createElement('span');
        idEl.className = 'eve-worker-row-id';
        idEl.textContent = id;
        const lblEl = document.createElement('span');
        lblEl.className = 'eve-worker-row-label';
        lblEl.textContent = (initialLabel === null || initialLabel === undefined)
          ? 'loading' : initialLabel;
        row.appendChild(idEl);
        row.appendChild(lblEl);
        if (opts.control instanceof HTMLElement) {
          opts.control.classList.add('eve-worker-row-control');
          row.appendChild(opts.control);
        }
        h.appendChild(row);
      } else {
        if (initialLabel !== null && initialLabel !== undefined) {
          const lblEl = row.querySelector('.eve-worker-row-label');
          if (lblEl) lblEl.textContent = initialLabel;
        }
        if (opts.error) row.classList.add('progress-row-error');
        if ('control' in opts) {
          const existing = row.querySelector('.eve-worker-row-control');
          if (existing) existing.remove();
          if (opts.control instanceof HTMLElement) {
            opts.control.classList.add('eve-worker-row-control');
            row.appendChild(opts.control);
          }
        }
      }
      h.hidden = false;
    },
    update(id, label) {
      const h = host();
      if (!h) return;
      const row = h.querySelector(`.eve-worker-row[data-load-id="${cssEscape(id)}"]`);
      if (!row) return;
      const lblEl = row.querySelector('.eve-worker-row-label');
      if (lblEl) lblEl.textContent = label || '';
    },
    remove(id) {
      const h = host();
      if (!h) return;
      const row = h.querySelector(`.eve-worker-row[data-load-id="${cssEscape(id)}"]`);
      if (row) row.remove();
      if (!h.firstChild) h.hidden = true;
    },
  };
}

export function createProgressModal(ids) {
  const base = createModal({ dialog: ids.dialog, closeX: ids.closeX, title: ids.title });
  const testEl = ids.test ? $(ids.test) : null;
  const detailEl = ids.detail ? $(ids.detail) : null;
  const barEl = ids.bar ? $(ids.bar) : null;
  const cancelBtnEl = ids.cancelBtn ? $(ids.cancelBtn) : null;
  const rows = createLoadRowBlock(ids.rowsHost);
  let controller = null;
  let mode = 'cancel'; // 'cancel' | 'close' | 'done'
  const cancelHandlers = new Set();

  // Throttled ETA append. updateEta carries a formatted string ("1m
  // 47s") or null; the rendered detail line is `${lastDetailText} ·
  // ETA ${etaText}` (or just the ETA if no detail text). DOM write
  // throttled to >=1s so the line doesn't jitter as the EWMA estimate
  // fluctuates.
  let lastDetailText = '';
  let pendingEta = null;
  let lastEtaWriteMs = 0;
  const ETA_MIN_WRITE_INTERVAL_MS = 1000;
  function commitDetail() {
    if (!detailEl) return;
    detailEl.textContent = pendingEta
      ? (lastDetailText ? `${lastDetailText} · ${pendingEta}` : pendingEta)
      : lastDetailText;
  }

  function fireCancel() {
    if (!controller || controller.signal.aborted) return;
    controller.abort();
    if (cancelBtnEl) cancelBtnEl.disabled = true;
    for (const cb of cancelHandlers) {
      try { cb(); } catch {}
    }
  }

  function finalClose() {
    base.close('progress-closed');
    rows.clear();
  }

  // Bottom button: cancel mode aborts; close/done modes finalClose.
  function handleButton() {
    if (mode === 'cancel') fireCancel();
    else finalClose();
  }
  if (cancelBtnEl) cancelBtnEl.addEventListener('click', handleButton);

  // Top-X / ESC are routed through the base's vetoable onRequestClose.
  // In 'cancel' mode with the controller not yet aborted, swallow the
  // request and abort instead, the next X/ESC closes for real.
  base.onRequestClose(() => {
    if (mode !== 'cancel') return true;  // close/done → allow close
    if (controller && controller.signal.aborted) return true;  // 2nd press
    fireCancel();
    return false;  // veto: stay open while abort propagates
  });
  // Cleanup on any close path.
  base.onClose(() => { rows.clear(); });

  function setCancelMode(newMode) {
    mode = newMode;
    if (!cancelBtnEl) return;
    cancelBtnEl.classList.remove('is-flashing');
    cancelBtnEl.disabled = false;
    if (newMode === 'cancel') {
      cancelBtnEl.textContent = 'Cancel';
    } else if (newMode === 'close') {
      cancelBtnEl.textContent = 'Close';
    } else if (newMode === 'done') {
      cancelBtnEl.textContent = 'Done';
      if (barEl) barEl.value = 1;
      void cancelBtnEl.offsetWidth; // reflow to restart animation
      cancelBtnEl.classList.add('is-flashing');
    }
  }

  return {
    get signal() { return controller ? controller.signal : null; },
    get bar() { return barEl; },
    open(titleText) {
      controller = new AbortController();
      cancelHandlers.clear();
      mode = 'cancel';
      lastDetailText = '';
      pendingEta = null;
      lastEtaWriteMs = 0;
      if (typeof titleText === 'string') base.setTitle(titleText);
      if (testEl) testEl.textContent = '';
      if (detailEl) detailEl.textContent = '';
      if (barEl) barEl.removeAttribute('value');
      rows.clear();
      setCancelMode('cancel');
      base.show();
    },
    close: finalClose,
    update({ test, detail }) {
      if (test !== undefined && testEl) testEl.textContent = test ?? '';
      if (detail !== undefined) {
        lastDetailText = detail ?? '';
        commitDetail();
      }
    },
    updateEta(text) {
      if (text == null) return;
      pendingEta = `ETA ${text}`;
      const now = performance.now();
      if (now - lastEtaWriteMs >= ETA_MIN_WRITE_INTERVAL_MS) {
        commitDetail();
        lastEtaWriteMs = now;
      }
    },
    rows,
    setCancelMode,
    showError(text) {
      rows.clear();
      rows.add('error', text, { error: true });
      setCancelMode('close');
    },
    done() {
      rows.clear();
      setCancelMode('done');
    },
    onCancel(cb) {
      if (typeof cb === 'function') cancelHandlers.add(cb);
    },
    cancel: fireCancel,
  };
}
