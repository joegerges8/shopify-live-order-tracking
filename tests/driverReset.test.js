// The forgot-password flow. A driver who cannot remember their password proves
// it is their account by knowing the email and the phone number on it, and
// gets a new password without the account itself changing. These pin the
// checks that stop that endpoint from being a way into someone else's account,
// and the profile-screen variant where the session stands in for the current
// password.

const test = require("node:test");
const assert = require("node:assert");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

process.env.JWT_SECRET = "test-secret";

// One driver on the books, phone stored the way they typed it at signup.
const driver = {
  id: 7,
  full_name: "Test Driver",
  email: "driver@example.com",
  phone: "+961 70 218 542",
  password_hash: "old-hash",
};

// What updateDriverPassword was last called with.
let written = null;

const driverServicePath = require.resolve("../src/services/driverService");
require.cache[driverServicePath] = {
  id: driverServicePath,
  filename: driverServicePath,
  loaded: true,
  exports: {
    getDriverByEmail: async (email) => (email === driver.email ? driver : undefined),
    getPublicDriverById: async (id) =>
      id === driver.id ? { id: driver.id, full_name: driver.full_name, email: driver.email } : null,
    updateDriverPassword: async (id, hash) => {
      written = { id, hash };
    },
    getDriverByPhone: async () => null,
    createDriver: async () => null,
  },
};

const {
  resetForgottenPassword,
  resetOwnPassword,
  clearResetAttempts,
} = require("../src/controllers/driverAuthController");
const requireDriverAuth = require("../src/middleware/requireDriverAuth");

function fakeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (body) => {
    res.body = body;
    return res;
  };
  return res;
}

async function reset(body) {
  const res = fakeRes();
  await resetForgottenPassword({ body }, res);
  return res;
}

test.beforeEach(() => {
  written = null;
  clearResetAttempts();
});

test("the right email and phone, in a different spelling, set a new password on the same account", async () => {
  const res = await reset({
    email: "driver@example.com",
    phone: "70218542",
    new_password: "fresh-pass",
  });

  assert.equal(res.statusCode, 200);
  assert.equal(written.id, 7, "the existing row is updated, not a new one made");
  assert.ok(await bcrypt.compare("fresh-pass", written.hash));
  assert.notEqual(written.hash, "fresh-pass", "stored hashed, never plain");
});

test("the wrong phone is refused, and told no more than an unknown email is", async () => {
  const wrongPhone = await reset({
    email: "driver@example.com",
    phone: "70218543",
    new_password: "fresh-pass",
  });
  const unknownEmail = await reset({
    email: "nobody@example.com",
    phone: "70218542",
    new_password: "fresh-pass",
  });

  assert.equal(wrongPhone.statusCode, 401);
  assert.equal(unknownEmail.statusCode, 401);
  assert.deepEqual(wrongPhone.body, unknownEmail.body);
  assert.equal(written, null);
});

test("a short password is refused before anything is looked up", async () => {
  const res = await reset({
    email: "driver@example.com",
    phone: "70218542",
    new_password: "abc",
  });

  assert.equal(res.statusCode, 400);
  assert.equal(written, null);
});

test("a missing field is a 400, not a crash", async () => {
  const res = await reset({ email: "driver@example.com", new_password: "fresh-pass" });
  assert.equal(res.statusCode, 400);
});

test("the sixth try on one email inside the window is told to wait", async () => {
  const guess = { email: "Driver@Example.com", phone: "1", new_password: "fresh-pass" };

  for (let i = 0; i < 5; i++) {
    assert.equal((await reset(guess)).statusCode, 401);
  }

  const sixth = await reset(guess);
  assert.equal(sixth.statusCode, 429);

  // Even the right phone is refused once the limit is reached — the limit is
  // what makes guessing pointless.
  const rightButLate = await reset({ ...guess, phone: "70218542" });
  assert.equal(rightButLate.statusCode, 429);
  assert.equal(written, null);
});

test("a logged-in driver sets a new password without the current one", async () => {
  const token = jwt.sign({ sub: "7", type: "driver" }, process.env.JWT_SECRET, {
    expiresIn: "1d",
  });
  const req = {
    get: (h) => (h === "Authorization" ? `Bearer ${token}` : ""),
    body: { new_password: "another-pass" },
  };

  let passed = false;
  requireDriverAuth(req, fakeRes(), () => {
    passed = true;
  });
  assert.equal(passed, true);

  const res = fakeRes();
  await resetOwnPassword(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(written.id, 7);
  assert.ok(await bcrypt.compare("another-pass", written.hash));
});

test("the logged-in variant still refuses a short password", async () => {
  const res = fakeRes();
  await resetOwnPassword({ driverId: 7, body: { new_password: "abc" } }, res);
  assert.equal(res.statusCode, 400);
  assert.equal(written, null);
});
