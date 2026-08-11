// In-page replacements for the browser's alert() / confirm() / prompt().
//
// The native dialogs freeze the whole tab until they are dismissed, which on a
// dispatch desk means every assignment, status change and copied link costs an
// extra click on a modal that cannot be styled, cannot be stacked and cannot be
// ignored. Everything here is drawn into the page instead:
//
//   • showToast    — replaces alert(): a corner notice that fades on its own.
//   • confirmAction— replaces confirm(): a real modal, but only where a wrong
//                    click is expensive (deleting an order, recording a payment).
//   • showCopyBox  — replaces prompt(): a readonly field to copy a link from.
//
// Messages are written with textContent, never innerHTML — they carry order
// numbers, driver names and raw backend error strings, none of which are safe
// to hand to the HTML parser.

const TOAST_LIFETIME_MS = 4500;

/* ===========================
   TOASTS  (replaces alert)
=========================== */

// One host for the whole page, created on first use so no page has to remember
// to add a container to its markup.
function toastHost() {
  let host = document.querySelector(".toast-host");
  if (!host) {
    host = document.createElement("div");
    host.className = "toast-host";
    // The stack announces itself politely: a dispatcher on a screen reader
    // hears "Driver assigned" without being yanked out of the table.
    host.setAttribute("role", "status");
    host.setAttribute("aria-live", "polite");
    document.body.appendChild(host);
  }
  return host;
}

/**
 * Shows a transient notice in the corner of the screen.
 *
 * @param {string} message  Text to show. Line breaks are preserved.
 * @param {"success"|"error"|"info"} [type="info"]  Controls the accent colour.
 */
export function showToast(message, type = "info") {
  const toast = document.createElement("div");
  toast.className = `toast toast-${type}`;
  toast.textContent = message;

  // Errors are the one thing worth reading twice, so they get a dismiss button
  // and stay put until the timer runs out rather than sliding away mid-sentence.
  const close = document.createElement("button");
  close.className = "toast-close";
  close.type = "button";
  close.setAttribute("aria-label", "Dismiss");
  close.textContent = "×";
  close.addEventListener("click", () => removeToast(toast));
  toast.appendChild(close);

  toastHost().appendChild(toast);

  // Let the element land in the DOM before starting the transition, otherwise
  // the browser has nothing to animate from.
  requestAnimationFrame(() => toast.classList.add("toast-visible"));

  setTimeout(() => removeToast(toast), TOAST_LIFETIME_MS);
  return toast;
}

function removeToast(toast) {
  if (!toast.isConnected) return;
  toast.classList.remove("toast-visible");
  // Matches the CSS transition; removing immediately would skip the fade.
  setTimeout(() => toast.remove(), 200);
}

/* ===========================
   CONFIRM  (replaces confirm)
=========================== */

/**
 * Asks the dispatcher to confirm an action they cannot take back.
 *
 * Unlike confirm() this does not block the page — it resolves a promise — so
 * callers must await it.
 *
 * @param {object}  options
 * @param {string}  options.title         Headline, e.g. "Delete order #1042?".
 * @param {string}  options.message       Body text. Line breaks are preserved.
 * @param {string}  [options.confirmLabel="Confirm"]
 * @param {string}  [options.cancelLabel="Cancel"]
 * @param {boolean} [options.danger=false] Paints the confirm button red.
 * @returns {Promise<boolean>} true if confirmed, false if cancelled.
 */
export function confirmAction({
  title,
  message,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  danger = false,
}) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";

    const dialog = document.createElement("div");
    dialog.className = "modal";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");

    const heading = document.createElement("h2");
    heading.className = "modal-title";
    heading.textContent = title;

    const body = document.createElement("p");
    body.className = "modal-message";
    body.textContent = message;

    const actions = document.createElement("div");
    actions.className = "modal-actions";

    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "modal-btn modal-btn-cancel";
    cancelBtn.textContent = cancelLabel;

    const confirmBtn = document.createElement("button");
    confirmBtn.type = "button";
    confirmBtn.className = danger
      ? "modal-btn modal-btn-danger"
      : "modal-btn modal-btn-confirm";
    confirmBtn.textContent = confirmLabel;

    actions.append(cancelBtn, confirmBtn);
    dialog.append(heading, body, actions);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    // Whatever had focus before the modal opened gets it back on close, so the
    // dispatcher's place in the table is not lost to a confirmation.
    const previouslyFocused = document.activeElement;

    function close(result) {
      document.removeEventListener("keydown", onKeydown, true);
      overlay.remove();
      if (previouslyFocused && previouslyFocused.focus) previouslyFocused.focus();
      resolve(result);
    }

    function onKeydown(event) {
      if (event.key === "Escape") {
        event.preventDefault();
        close(false);
        return;
      }
      // Keep Tab inside the dialog: two buttons, so this is just a swap.
      if (event.key === "Tab") {
        event.preventDefault();
        (document.activeElement === confirmBtn ? cancelBtn : confirmBtn).focus();
      }
    }

    cancelBtn.addEventListener("click", () => close(false));
    confirmBtn.addEventListener("click", () => close(true));
    // Clicking the backdrop cancels; clicking inside the dialog must not.
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) close(false);
    });
    document.addEventListener("keydown", onKeydown, true);

    // Cancel starts focused so a stray Enter never confirms a deletion.
    cancelBtn.focus();
  });
}

/* ===========================
   COPY BOX  (replaces prompt)
=========================== */

/**
 * Shows a value in a readonly field for the dispatcher to copy by hand. Used as
 * the fallback when the clipboard API is unavailable (an http:// origin, or a
 * browser that refuses the write).
 *
 * @param {string} title  Headline above the field.
 * @param {string} value  The text to display, pre-selected for copying.
 */
export function showCopyBox(title, value) {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";

  const dialog = document.createElement("div");
  dialog.className = "modal";
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");

  const heading = document.createElement("h2");
  heading.className = "modal-title";
  heading.textContent = title;

  const field = document.createElement("input");
  field.type = "text";
  field.className = "modal-input";
  field.readOnly = true;
  field.value = value;

  const actions = document.createElement("div");
  actions.className = "modal-actions";

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "modal-btn modal-btn-confirm";
  closeBtn.textContent = "Done";

  actions.appendChild(closeBtn);
  dialog.append(heading, field, actions);
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  function close() {
    document.removeEventListener("keydown", onKeydown, true);
    overlay.remove();
  }

  function onKeydown(event) {
    if (event.key === "Escape") close();
  }

  closeBtn.addEventListener("click", close);
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) close();
  });
  document.addEventListener("keydown", onKeydown, true);

  // Pre-selected so the dispatcher only has to press Ctrl+C.
  field.focus();
  field.select();
}
