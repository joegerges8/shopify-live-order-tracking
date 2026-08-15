// What a dispatcher's area correction teaches the classifier.
//
// The dashboard lets the dispatcher move an order out of 'Other' (or overrule
// a wrong guess), and each such correction is remembered so the next order
// with the same city files itself. These tests pin down which corrections are
// worth remembering — the storage itself is a two-line upsert, but a wrong
// decision here either learns junk or forgets a good lesson.

const test = require("node:test");
const assert = require("node:assert");

const {
  decideAreaCorrection,
  resolveAreaOrUnknown,
  UNKNOWN_AREA,
} = require("../src/utils/areaLookup");

test("an unrecognized city corrected to a real area is learned", () => {
  // The motivating case: a village absent from the static table, filed under
  // its caza by hand once.
  assert.strictEqual(resolveAreaOrUnknown("Dekene l zaytoun"), UNKNOWN_AREA);

  const decision = decideAreaCorrection("Dekene l zaytoun", "Metn");
  assert.strictEqual(decision.action, "save");
  assert.strictEqual(decision.key, "dekene l zaytoun");
});

test("the key is the normalized text, so spellings collapse the same way", () => {
  // The same normalization the resolver applies at classification time, so
  // what is learned under one form is found under its equivalent forms.
  const learned = decideAreaCorrection("  Dékené-l-Zaytoun ", "Metn");
  assert.strictEqual(learned.key, "dekene l zaytoun");
});

test("overruling a wrong guess is learned too", () => {
  // 'Awkar' resolves to Metn on its own; the dispatcher knows this customer's
  // "awkar" is really somewhere else. Their judgement wins for that text.
  assert.strictEqual(resolveAreaOrUnknown("Awkar"), "Metn");
  assert.strictEqual(decideAreaCorrection("Awkar", "Keserwan").action, "save");
});

test("a correction that agrees with the table is not stored", () => {
  // Nothing to learn — and if a stale row exists for this city, it should go,
  // so the static table (which may have been fixed meanwhile) speaks again.
  const decision = decideAreaCorrection("Jounieh", "Keserwan");
  assert.strictEqual(decision.action, "forget");
});

test("moving an order back to Other disowns the learned correction", () => {
  const decision = decideAreaCorrection("Dekene l zaytoun", UNKNOWN_AREA);
  assert.strictEqual(decision.action, "forget");
});

test("a blank city teaches nothing", () => {
  // Remembering '' would stamp one area onto every order that arrives with no
  // city at all.
  for (const city of ["", "   ", null, undefined]) {
    assert.strictEqual(decideAreaCorrection(city, "Metn").action, "none");
  }
});
