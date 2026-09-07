// A driver's phone number, reduced to the digits that identify it.
//
// Signup stores the phone exactly as the driver typed it, so the same number
// sits in the table as '+961 70 218 542' for one driver and '70218542' or
// '03 719 871' for another. The forgot-password flow asks the driver to type
// their phone again, months later, and they will not remember which spelling
// they used — so the comparison has to see through all of them.
//
// This is the same rule the driver app uses to match customer phone numbers
// (lib/utils/phone.dart, normalizePhone): everything that is formatting rather
// than identity comes off. '+', spaces, dashes and brackets; then the '00'
// international prefix; then Lebanon's country code; then the trunk '0' the
// local form carries and the international form drops.

const LEBANON_COUNTRY_CODE = "961";

function normalizeDriverPhone(raw) {
  let digits = String(raw ?? "").replace(/\D/g, "");

  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.startsWith(LEBANON_COUNTRY_CODE)) {
    digits = digits.slice(LEBANON_COUNTRY_CODE.length);
  }

  return digits.replace(/^0+/, "");
}

// Whether two spellings are the same number. A value that reduces to nothing
// ('+961' on its own, or an empty field) matches nothing, including another
// empty value — otherwise a driver row with a blank phone would be resettable
// by anyone who left the phone field blank.
function phonesMatch(a, b) {
  const left = normalizeDriverPhone(a);
  const right = normalizeDriverPhone(b);
  return left.length > 0 && left === right;
}

module.exports = { normalizeDriverPhone, phonesMatch };
