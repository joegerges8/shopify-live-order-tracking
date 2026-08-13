// clear-unfulfilled-tags.js
//
// One-off cleanup for orders still wearing an "Unfulfilled" tag in Shopify.
// The app no longer writes that tag, and the next status change on an order
// strips it — but an order that never changes status again would keep it
// forever, so this walks the existing ones and clears them.
//
//   node scripts/clear-unfulfilled-tags.js            # every store
//   node scripts/clear-unfulfilled-tags.js --store 3  # one store only
//
// It re-syncs each order's delivery tag from the status the order actually
// has, so an order is left tagged the truth — "Picked up by …" for one out
// with a driver, nothing at all for one sitting unfulfilled. Orders whose tags
// are already right cost one read and no write, so the script is safe to run
// repeatedly.
//
// Requires DATABASE_URL in the environment, same as the server.

const pool = require("../src/config/db");
const { syncOrderTagToShopify } = require("../src/services/shopifyService");

const storeArgIndex = process.argv.indexOf("--store");
const storeId = storeArgIndex === -1 ? null : Number(process.argv[storeArgIndex + 1]);

// Shopify allows two calls a second per store on the REST admin API, and each
// order here costs a read plus at most a write. Pausing between orders keeps a
// long run from spending the whole bucket and getting throttled.
const PAUSE_MS = 600;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Statuses the tag sync writes a tag for. Anything else it leaves alone, which
// is right during normal running — OUT_FOR_DELIVERY is not worth a tag of its
// own — but no use here, where the point is to reach orders that were tagged
// and never touched again. So the rest are mapped onto the status whose tag
// they should be wearing: a driver is still carrying an OUT_FOR_DELIVERY
// order, so it keeps the Picked Up tag, and everything else has no driver
// behind it and clears.
const TAGGED_STATUSES = ["ASSIGNED", "PICKED_UP", "DELIVERED", "RETURNED", "CANCELLED"];
const CLEARING_STATUS = "UNFULFILLED";

function tagStatusFor(orderStatus) {
  if (TAGGED_STATUSES.includes(orderStatus)) return orderStatus;
  if (orderStatus === "OUT_FOR_DELIVERY") return "PICKED_UP";
  return CLEARING_STATUS;
}

async function main() {
  if (storeArgIndex !== -1 && !Number.isFinite(storeId)) {
    console.error("--store needs a store id, e.g. --store 3");
    process.exit(1);
  }

  const { rows } = await pool.query(
    `SELECT o.id, o.store_id, o.shopify_order_id, o.order_number, o.order_status,
            d.full_name AS driver_name
     FROM orders o
     LEFT JOIN drivers d ON d.id = o.assigned_driver_id
     WHERE o.shopify_order_id IS NOT NULL
       ${storeId ? "AND o.store_id = $1" : ""}
     ORDER BY o.id`,
    storeId ? [storeId] : []
  );

  console.log(`Re-syncing delivery tags for ${rows.length} order(s)…`);

  let failed = 0;
  for (const row of rows) {
    try {
      await syncOrderTagToShopify(
        row.store_id,
        row.shopify_order_id,
        tagStatusFor(row.order_status),
        { driverName: row.driver_name }
      );
    } catch (error) {
      failed += 1;
      console.error(`Order ${row.order_number || row.id}: ${error.message}`);
    }
    await sleep(PAUSE_MS);
  }

  console.log(`Done. ${rows.length - failed} order(s) synced, ${failed} failed.`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
