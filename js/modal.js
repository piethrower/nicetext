// createModal({dialog, closeX?}): base factory for ALL <dialog>s in
// the app. Owns the universal chrome:
//   - close-X click → request close
//   - ESC key (dialog native 'cancel' event) → request close
//   - Single dialog 'close' event listener fans out to onClose(cb)s
//   - "pendingValue" channel: a layer can stash an intended resolution
//     value before calling close(); the close listener reads it (else
//     defaults to 'cancel') and passes to the onClose callbacks.
//
// Specialized factories (createOptionsModal, createProgressModal) layer
// on top of this. They do NOT re-wire close-X or ESC; they hook the
// base's onRequestClose / onClose primitives.
//
// API:
//   show()                 : open the dialog (showModal)
//   close(value?)          : stash value (if given) and close
//   onRequestClose(cb)     : vetoable: cb() returning false suppresses
//                             the close (used by progress modals to
//                             swallow the first ESC/X and abort instead)
//   onClose(cb)            : fires after dialog 'close' event, with
//                             pendingValue ?? 'cancel'
//   el                     : the dialog element (escape hatch)
//
// Rule 26: textContent only (this factory doesn't touch text, that's
// the caller's job via populate()).

const $ = (id) => document.getElementById(id);

export function createModal({ dialog, closeX, title } = {}) {
  const dlg = $(dialog);
  if (!dlg) throw new Error(`createModal: dialog #${dialog} not found`);
  const closeXEl = closeX ? $(closeX) : null;
  const titleEl = title ? $(title) : null;
  // If both title and close-X live as top-level children of the
  // dialog, wrap them in a .modal-header so every dialog has the
  // same flex-row chrome (title left, X right, baseline aligned).
  // Idempotent: re-runs on a wrapped dialog leave it alone.
  if (titleEl && closeXEl
      && titleEl.parentNode === dlg && closeXEl.parentNode === dlg) {
    const header = document.createElement('div');
    header.className = 'modal-header';
    dlg.insertBefore(header, dlg.firstChild);
    header.appendChild(titleEl);
    header.appendChild(closeXEl);
  }
  const requestCloseHandlers = new Set();
  const closeListeners = new Set();
  let pendingValue = null;

  function requestClose() {
    // Vetoable: any handler returning false suppresses the close.
    for (const cb of requestCloseHandlers) {
      try {
        if (cb() === false) return;
      } catch {}
    }
    if (dlg.open) dlg.close();
  }

  if (closeXEl) closeXEl.addEventListener('click', requestClose);
  dlg.addEventListener('cancel', (ev) => {
    // <dialog>'s native cancel default-closes the dialog. Intercept so
    // requestClose() can run veto handlers first.
    ev.preventDefault();
    requestClose();
  });
  dlg.addEventListener('close', () => {
    const v = pendingValue ?? 'cancel';
    pendingValue = null;
    for (const cb of closeListeners) {
      try { cb(v); } catch {}
    }
  });

  return {
    el: dlg,
    show() { if (!dlg.open) dlg.showModal(); },
    close(value) {
      if (value !== undefined) pendingValue = value;
      if (dlg.open) dlg.close();
    },
    onRequestClose(cb) { requestCloseHandlers.add(cb); },
    onClose(cb) { closeListeners.add(cb); },
    setTitle(text) { if (titleEl && typeof text === 'string') titleEl.textContent = text; },
  };
}
