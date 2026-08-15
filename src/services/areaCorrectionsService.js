// areaCorrectionsService.js
//
// The memory behind the dashboard's area corrections.
//
// The static town table classifies ~96% of orders; the dispatcher fixes the
// rest by hand, one order at a time — and until this table existed, that fix
// taught the system nothing. The next order from the same unrecognized city
// landed in 'Other' again, and the dispatcher corrected it again, forever.
//
// Now a correction is remembered: when the dispatcher moves an order out of
// 'Other' (or overrules a wrong guess), the normalized city string is stored
// with the chosen area, and the webhook consults these corrections before the
// static table when classifying new orders. Which corrections are worth
// keeping is decided by areaLookup.decideAreaCorrection — the rules live
// there, pure and tested; this module only applies them to Postgres.
//
// The corrections are global rather than per store. A city is a place on the
// ground, not a property of whoever sold the order, and the static table the
// corrections patch is global for the same reason.
//
// What this deliberately does not learn: coordinates. The dashboard's
// correction names a caza, so a learned city pins at the caza centre — town
// precision still comes from town-coords.json.

const pool = require("../config/db");
const {
  decideAreaCorrection,
  resolveAreaOrUnknown,
  normalize,
} = require("../utils/areaLookup");

// The corrections, cached in memory. There are at most a few hundred of these
// — one per misspelled city the shop has ever seen — and the webhook asks on
// every order, so they are worth keeping loaded. The cache reloads after
// CACHE_TTL_MS so several backend instances converge on each other's
// corrections without any coordination.
const CACHE_TTL_MS = 60 * 1000;
let cache = null;
let cacheLoadedAt = 0;

async function loadCache() {
  const result = await pool.query(
    `SELECT city_key, area FROM area_corrections`
  );
  cache = new Map(result.rows.map((row) => [row.city_key, row.area]));
  cacheLoadedAt = Date.now();
}

async function getCache() {
  if (!cache || Date.now() - cacheLoadedAt > CACHE_TTL_MS) {
    await loadCache();
  }
  return cache;
}

// The area for a city, corrections first.
//
// A stored correction wins over the static table outright: the dispatcher
// made it while looking at a real order, and it is keyed to the exact
// normalized city text, so it can never reach further than the string it was
// taught on. Everything else falls through to the static lookup unchanged.
//
// Never throws — classification runs inside webhook handling, and an order
// must not be lost because this table was briefly unreachable. On any failure
// the static answer stands, which is exactly yesterday's behaviour.
async function resolveAreaWithCorrections(city) {
  try {
    const corrections = await getCache();
    const learned = corrections.get(normalize(city));
    if (learned) return learned;
  } catch (error) {
    console.error("Area corrections unavailable, using static table:", error);
  }
  return resolveAreaOrUnknown(city);
}

// Remembers (or forgets) what a dispatcher's correction teaches.
//
// Called after the order row itself has been updated — the correction the
// dispatcher asked for is already done, and this is the learning on top, so
// a failure here is logged and swallowed rather than failing their request.
async function learnAreaCorrection(city, area) {
  const decision = decideAreaCorrection(city, area);

  try {
    if (decision.action === "save") {
      await pool.query(
        `INSERT INTO area_corrections (city_key, area)
         VALUES ($1, $2)
         ON CONFLICT (city_key)
         DO UPDATE SET area = EXCLUDED.area, updated_at = NOW()`,
        [decision.key, area]
      );
    } else if (decision.action === "forget") {
      await pool.query(`DELETE FROM area_corrections WHERE city_key = $1`, [
        decision.key,
      ]);
    } else {
      return;
    }

    // Refresh rather than patch, so this instance's cache is also picking up
    // whatever other corrections were made elsewhere since the last load.
    await loadCache();
  } catch (error) {
    console.error("Failed to store area correction:", error);
  }
}

module.exports = {
  resolveAreaWithCorrections,
  learnAreaCorrection,
};
