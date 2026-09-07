// What happens to a driver's session over time. Tokens last 30 days, and until
// POST /api/drivers/me/refresh existed nothing renewed them: on day 31 every
// request answered 401 "Unauthorized", the app kept the dead token, and the
// driver was told to check their phone's location settings. These pin the two
// halves of the fix on the backend side — an expired token is refused with
// exactly the 401 the app now acts on, and a live one can be traded for a
// fresh one.

const test = require("node:test");
const assert = require("node:assert");
const jwt = require("jsonwebtoken");

process.env.JWT_SECRET = "test-secret";

// The controller reaches the database through driverService; stand in for it
// before the controller is loaded so no Postgres is needed.
const driverServicePath = require.resolve("../src/services/driverService");
require.cache[driverServicePath] = {
  id: driverServicePath,
  filename: driverServicePath,
  loaded: true,
  exports: {
    getPublicDriverById: async (id) =>
      id === 7 ? { id: 7, full_name: "Test Driver", email: "t@example.com" } : null,
    getDriverByPhone: async () => null,
    getDriverByEmail: async () => null,
    createDriver: async () => null,
    updateDriverPassword: async () => null,
  },
};

const requireDriverAuth = require("../src/middleware/requireDriverAuth");
const { refreshToken } = require("../src/controllers/driverAuthController");

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

function fakeReq(token) {
  return { get: (h) => (h === "Authorization" ? `Bearer ${token}` : "") };
}

function runAuth(token) {
  const req = fakeReq(token);
  const res = fakeRes();
  let passed = false;
  requireDriverAuth(req, res, () => {
    passed = true;
  });
  return { req, res, passed };
}

test("an expired token is refused with the 401 the app acts on", () => {
  const expired = jwt.sign(
    { sub: "7", type: "driver" },
    process.env.JWT_SECRET,
    { expiresIn: -1 }
  );

  const { res, passed } = runAuth(expired);

  assert.equal(passed, false);
  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.body, { error: "Unauthorized" });
});

test("a live token is traded for a fresh one for the same driver", async () => {
  const live = jwt.sign({ sub: "7", type: "driver" }, process.env.JWT_SECRET, {
    expiresIn: "1d",
  });

  const { req, passed } = runAuth(live);
  assert.equal(passed, true);

  const res = fakeRes();
  await refreshToken(req, res);

  assert.equal(res.statusCode, 200);
  assert.ok(res.body.token, "a token comes back");
  assert.equal(res.body.driver.id, 7);

  const payload = jwt.verify(res.body.token, process.env.JWT_SECRET);
  assert.equal(payload.sub, "7");
  assert.equal(payload.type, "driver");

  // Thirty days out, give or take the seconds the test took.
  const thirtyDays = 30 * 24 * 60 * 60;
  assert.ok(Math.abs(payload.exp - payload.iat - thirtyDays) < 5);

  // And the fresh token gets through the same gate.
  assert.equal(runAuth(res.body.token).passed, true);
});

test("a token for a driver that no longer exists is not renewed", async () => {
  const gone = jwt.sign({ sub: "99", type: "driver" }, process.env.JWT_SECRET, {
    expiresIn: "1d",
  });

  const { req, passed } = runAuth(gone);
  assert.equal(passed, true);

  const res = fakeRes();
  await refreshToken(req, res);

  assert.equal(res.statusCode, 404);
});
