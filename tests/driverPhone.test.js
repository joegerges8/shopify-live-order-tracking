// Signup stores a driver's phone exactly as typed, and the forgot-password
// flow asks for it again months later. These pin that the comparison sees
// through the ways the same Lebanese number gets written.

const test = require("node:test");
const assert = require("node:assert");

const { normalizeDriverPhone, phonesMatch } = require("../src/utils/driverPhone");

test("the same number in international, plain and local spelling is one number", () => {
  assert.strictEqual(normalizeDriverPhone("+961 70 218 542"), "70218542");
  assert.strictEqual(normalizeDriverPhone("0096170218542"), "70218542");
  assert.strictEqual(normalizeDriverPhone("70218542"), "70218542");
  assert.strictEqual(normalizeDriverPhone("070 218 542"), "70218542");
  assert.ok(phonesMatch("+961 70 218 542", "70218542"));
  assert.ok(phonesMatch("03 719 871", "+961 3 719 871"));
});

test("a country code on its own matches nothing, not even another blank", () => {
  assert.strictEqual(normalizeDriverPhone("+961"), "");
  assert.equal(phonesMatch("+961", "+961"), false);
  assert.equal(phonesMatch("", ""), false);
  assert.equal(phonesMatch(null, undefined), false);
});

test("a different number does not match", () => {
  assert.equal(phonesMatch("70218542", "70218543"), false);
  assert.equal(phonesMatch("70218542", "3718542"), false);
});
