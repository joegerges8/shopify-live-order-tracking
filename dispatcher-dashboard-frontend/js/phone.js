// Phone numbers, and the two shapes the dashboard needs them in.
//
// The phone column is free-form text typed by a customer into a Shopify
// checkout, so the same line reaches the dispatcher written any number of
// ways: '+961 70 218 542' from one store, '70218542' from the next, sometimes
// '0096170218542' or a local '03 719 871'. Nothing upstream normalises it.
//
// Dialling needs the full international number — toWhatsAppNumber. Reading
// needs the shortest form a dispatcher in Lebanon recognises at a glance, with
// the country code they already know taken off — displayPhone. Neither touches
// what is stored: the wa.me link keeps using the number that dials.
//
// Mirrors lib/utils/phone.dart in the driver app, so a number reads the same
// on both screens.

// Country code assumed for numbers stored in local form (03 719 871).
export const DEFAULT_COUNTRY_CODE = "961"; // Lebanon

// wa.me wants digits only, including the country code and without a leading +.
export function toWhatsAppNumber(rawPhone) {
  if (!rawPhone) return null;

  const trimmed = String(rawPhone).trim();
  const digits = trimmed.replace(/\D/g, "");
  if (!digits) return null;

  // Already international: +961…
  if (trimmed.startsWith("+")) return digits;
  // Dialling prefix instead of a plus: 00961…
  if (digits.startsWith("00")) return digits.slice(2);
  // Local form, the leading 0 is dropped when the country code goes on.
  if (digits.startsWith("0")) return DEFAULT_COUNTRY_CODE + digits.slice(1);
  // Bare number that already carries the country code.
  if (digits.startsWith(DEFAULT_COUNTRY_CODE)) return digits;

  return DEFAULT_COUNTRY_CODE + digits;
}

// The number as it should be read in a table: no country code.
//
// A dispatcher working Lebanon knows the +961, so printing it only makes two
// orders look like different kinds of number when they are the same kind,
// written differently by two stores. Only an actual Lebanese country code is
// taken off — a foreign number keeps its code, which is the part that says it
// is foreign — and a number that arrived without one is passed through exactly
// as the store saved it, spacing and all: it is already in the short form, and
// rewriting someone's '03 719 871' into '03719871' would be tidying for its
// own sake. When stripping the code leaves a seven-digit national number
// ('3719871', an 03 mobile or an 01 landline) the trunk zero goes back on,
// since that is how the number is said and dialled at home.
//
// Anything that leaves nothing behind ('+961' on its own, or a column holding
// punctuation) is returned untouched rather than blanked, so a number the
// dashboard does not understand is still shown instead of disappearing.
export function displayPhone(rawPhone) {
  const trimmed = String(rawPhone ?? "").trim();
  if (!trimmed) return "";

  let rest = trimmed.replace(/\D/g, "");
  if (rest.startsWith("00")) rest = rest.slice(2);

  // No Lebanese country code to take off — either already the short form, or
  // a foreign number whose own code has to stay visible.
  if (!rest.startsWith(DEFAULT_COUNTRY_CODE)) return trimmed;

  rest = rest.slice(DEFAULT_COUNTRY_CODE.length);
  if (!rest) return trimmed;

  // '3719871' is how the international form writes an '03 719 871'.
  if (rest.length === 7) return `0${rest}`;

  return rest;
}
