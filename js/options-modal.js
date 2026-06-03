// createOptionsModal: confirm/options-style <dialog> with N action
// buttons. Layers on top of createModal (which owns close-X + ESC +
// the dialog lifecycle); this factory only adds the buttons-resolve-a-
// Promise semantics.
//
// ids: { dialog, title?, closeX?, statusEl?, buttons: [{id, value, primary?, beforeResolve?}] }
//
// Returns:
//   open({ title?, populate?, cleanup? }) → Promise resolving with the
//     picked button's value, or 'cancel' on close-X / ESC.
//   close() : programmatic close, resolves the open() promise with 'cancel'.
//   setStatus(msg, err?) : write a status line (when statusEl is wired).
//
// beforeResolve: if a button hook throws, the dialog stays open and
// the message is rendered into statusEl with .err class. Useful for
// async setup that can fail (e.g. service-worker activation).

import { createModal } from './modal.js';

const $ = (id) => document.getElementById(id);

export function createOptionsModal(ids) {
  const base = createModal({ dialog: ids.dialog, closeX: ids.closeX, title: ids.title });
  const statusEl = ids.statusEl ? $(ids.statusEl) : null;
  const buttons = (ids.buttons || []).map(b => ({ ...b, el: $(b.id) }));

  let resolveFn = null;
  let activeCleanup = null;
  const setStatus = (msg, err = false) => {
    if (!statusEl) return;
    statusEl.textContent = msg || '';
    statusEl.classList.toggle('err', !!err);
  };
  const setButtonsDisabled = (disabled) => {
    for (const b of buttons) b.el.disabled = disabled;
  };

  // Base fires onClose with the pendingValue (set by a button click)
  // or 'cancel' for close-X / ESC. We run cleanup and resolve here.
  base.onClose((value) => {
    if (activeCleanup) {
      try { activeCleanup(); } catch {}
      activeCleanup = null;
    }
    if (resolveFn) {
      const r = resolveFn;
      resolveFn = null;
      r(value);
    }
  });

  for (const b of buttons) {
    b.el.addEventListener('click', async () => {
      if (b.beforeResolve) {
        setButtonsDisabled(true);
        try {
          await b.beforeResolve();
        } catch (err) {
          setStatus(err?.message || String(err), true);
          setButtonsDisabled(false);
          return;
        }
      }
      // Set pendingValue THEN close, the base's onClose listener
      // receives the button's value (not 'cancel').
      base.close(b.value);
    });
  }

  return {
    open({ title, populate, cleanup } = {}) {
      if (title !== undefined) base.setTitle(title);
      setStatus('');
      setButtonsDisabled(false);
      if (populate) populate();
      activeCleanup = cleanup || null;
      base.show();
      return new Promise((resolve) => { resolveFn = resolve; });
    },
    close(value) { base.close(value ?? 'cancel'); },
    setStatus,
    // Pass-through to the base's vetoable close-request hook. Returning
    // false from the callback suppresses close-X / ESC; the consumer is
    // expected to drive close() itself once it's ready (e.g. after an
    // animation, async confirmation, etc.).
    onRequestClose: (cb) => base.onRequestClose(cb),
  };
}
