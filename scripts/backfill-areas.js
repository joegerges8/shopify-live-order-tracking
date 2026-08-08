// backfill-areas.js
//
// Fills the orders.area column for rows written before the column existed, and
// re-classifies rows sitting in 'Other' after the lookup table has been taught
// new towns. Safe to run repeatedly.
//
//   node scripts/backfill-areas.js            # only rows with a NULL area
//   node scripts/backfill-areas.js --retry    # also retry rows stuck on 'Other'
//   node scripts/backfill-areas.js --dry-run  # report what would change
//
// Rows a dispatcher corrected by hand are never touched by the default run:
// they hold a real area name, so they are not NULL and not 'Other'. Only
// --retry revisits 'Other', which by definition was never a human's choice.
//
// Requires DATABASE_URL in the environment, same as the server.

const pool = require("../src/config/db");
const { resolveArea, UNKNOWN_AREA } = require("../src/utils/areaLookup");

const retry = process.argv.includes("--retry");
const dryRun = process.argv.includes("--dry-run");

async function main() {
  const where = retry
    ? `area IS NULL OR area = $1`
    : `area IS NULL`;
  const params = retry ? [UNKNOWN_AREA] : [];

  const { rows } = await pool.query(
    `SELECT id, city, area FROM orders WHERE ${where} ORDER BY id`,
    params
  );

  console.log(`Candidate rows: ${rows.length}${retry ? " (including 'Other')" : ""}`);

  const counts = new Map();
  let updated = 0;
  let stillUnknown = 0;

  for (const row of rows) {
    const area = resolveArea(row.city) || UNKNOWN_AREA;
    if (area === UNKNOWN_AREA) stillUnknown++;

    // Skip no-op writes so --retry doesn't churn every unresolved row.
    if (row.area === area) continue;

    counts.set(area, (counts.get(area) || 0) + 1);
    updated++;

    if (!dryRun) {
      await pool.query(`UPDATE orders SET area = $1 WHERE id = $2`, [area, row.id]);
    }
  }

  console.log(`${dryRun ? "Would update" : "Updated"}: ${updated}`);
  console.log(`Still unresolved ('${UNKNOWN_AREA}'): ${stillUnknown}`);

  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  for (const [area, count] of ranked) {
    console.log(`  ${area.padEnd(18)} ${count}`);
  }
}

main()
  .catch((error) => {
    console.error("Backfill failed:", error.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
