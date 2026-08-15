// resequence-routes.js
//
// Recomputes orders.route_sequence — the order a driver's run should be driven
// in — for one driver or for everybody. Safe to run repeatedly.
//
//   node scripts/resequence-routes.js --all          # every driver holding orders
//   node scripts/resequence-routes.js --driver 7     # one driver
//   node scripts/resequence-routes.js --all --dry-run
//
// The server does this by itself whenever a driver's run changes shape, so
// this exists for the two cases it cannot cover: filling the column in after
// the migration without waiting for the next assignment, and re-running a fleet
// after the warehouse moved or a Maps key was finally configured.
//
// Requires DATABASE_URL in the environment, same as the server. GOOGLE_MAPS_
// SERVER_KEY is optional — without it every run falls back to straight-line
// distance from the warehouse, which the report below says out loud.

const pool = require("../src/config/db");
const { getWarehouse } = require("../src/config/warehouse");
const { isConfigured } = require("../src/services/mapsService");
const { resequenceDriverRoute } = require("../src/services/routeOrderService");

const all = process.argv.includes("--all");
const dryRun = process.argv.includes("--dry-run");
const driverFlag = process.argv.indexOf("--driver");
const driverId = driverFlag === -1 ? null : Number(process.argv[driverFlag + 1]);

async function driversWithActiveOrders() {
  const { rows } = await pool.query(
    `SELECT DISTINCT assigned_driver_id AS id
     FROM orders
     WHERE assigned_driver_id IS NOT NULL
       AND order_status NOT IN ('DELIVERED', 'RETURNED', 'CANCELLED')
     ORDER BY 1`
  );
  return rows.map((row) => row.id);
}

async function main() {
  if (!all && !Number.isFinite(driverId)) {
    console.error("Usage: node scripts/resequence-routes.js --all | --driver <id> [--dry-run]");
    process.exitCode = 1;
    return;
  }

  const warehouse = getWarehouse();
  console.log(`Warehouse: ${warehouse.name} (${warehouse.latitude}, ${warehouse.longitude})`);
  console.log(
    isConfigured()
      ? "Google Directions: configured — routes will be optimised."
      : "Google Directions: no GOOGLE_MAPS_SERVER_KEY — falling back to straight-line distance."
  );

  const ids = all ? await driversWithActiveOrders() : [driverId];
  console.log(`Drivers to resequence: ${ids.length}`);

  if (dryRun) {
    console.log("Dry run: nothing written.");
    for (const id of ids) console.log(`  driver ${id}`);
    return;
  }

  const sources = new Map();

  for (const id of ids) {
    const report = await resequenceDriverRoute(id);
    sources.set(report.source, (sources.get(report.source) || 0) + 1);
    console.log(
      `  driver ${String(id).padEnd(5)} ${String(report.orders).padStart(3)} orders ` +
        `over ${String(report.stops).padStart(3)} stops  ${report.source}`
    );
  }

  console.log("\nBy source:");
  for (const [source, count] of [...sources.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${source.padEnd(10)} ${count}`);
  }
}

main()
  .catch((error) => {
    console.error("Resequence failed:", error.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
