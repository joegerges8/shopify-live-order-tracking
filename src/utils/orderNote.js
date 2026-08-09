// orderNote.js
//
// Reads the note a Shopify order carries and normalises it for orders.note,
// which the driver app shows on the order detail screen.
//
// The note is the "Notes" field on the order in the Shopify admin — the place
// the merchant already writes delivery instructions ("second floor, no lift",
// "call 10 minutes before"). Shopify also puts the checkout's order-instructions
// field there, so a note can come from the customer as well as from staff.
//
// Shopify sends the field as null when there is no note and as an empty string
// once a note has been written and cleared again; both mean "nothing to show",
// so both collapse to null and the driver app renders no note card.

// Shopify imposes no length limit worth relying on, and a runaway note would
// be unreadable on a phone anyway. Long notes are cut rather than dropped so
// the driver still gets the beginning, which is where instructions live.
const MAX_NOTE_LENGTH = 2000;

function extractOrderNote(order) {
  const raw = order?.note;
  if (raw === null || raw === undefined) return null;

  const trimmed = String(raw).trim();
  if (!trimmed.length) return null;

  return trimmed.length > MAX_NOTE_LENGTH
    ? `${trimmed.slice(0, MAX_NOTE_LENGTH).trimEnd()}…`
    : trimmed;
}

module.exports = { extractOrderNote, MAX_NOTE_LENGTH };
