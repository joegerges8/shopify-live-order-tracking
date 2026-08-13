const pool = require("../config/db");
const { randomUUID } = require("crypto");
const {
  syncOrderTagToShopify,
  markDeliveredInShopify,
  markFulfilledInShopify,
  markUnfulfilledInShopify,
  cancelOrderInShopify,
  deleteOrderInShopify,
  markOrderPaidInShopify,
  fetchOrderCustomerFieldsFromShopify,
  importOrdersFromShopify,
} = require("./shopifyService");

// How recent a GPS ping must be for an order to count as "the driver is on the
// road with it". Matches ETA_START_WINDOW_SECONDS in etaService — both answer
// the same question, one for counting stops and one for revealing the ETA.
const STARTED_WINDOW_SECONDS =
  Number(process.env.ETA_START_WINDOW_SECONDS) > 0
    ? Number(process.env.ETA_START_WINDOW_SECONDS)
    : 600;

// Guards the empty-dashboard auto-import so a store whose import keeps failing
// doesn't hit Shopify on every page load.
const lastAutoImportAt = new Map();
const AUTO_IMPORT_COOLDOWN_MS = 5 * 60 * 1000;

// Completed orders drop off the dashboard once they're this old. They stay in
// the database and in Shopify — this only controls what the dispatcher sees,
// so the list stays short and quick to load.
const DEFAULT_RETENTION_DAYS = 7;

function getRetentionDays() {
  const configured = Number(process.env.DASHBOARD_ORDER_RETENTION_DAYS);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_RETENTION_DAYS;
}

// Repairing a row costs one Shopify API call, and the dashboard reloads every
// 30 seconds, so repairs are capped per request and each order is only retried
// once an hour instead of on every poll.
const BACKFILL_PER_REQUEST = 5;
const BACKFILL_RETRY_MS = 60 * 60 * 1000;
const backfillAttempts = new Map();

function shouldAttemptBackfill(order) {
  const lastAttempt = backfillAttempts.get(order.shopify_order_id);
  return !lastAttempt || Date.now() - lastAttempt > BACKFILL_RETRY_MS;
}

function recordBackfillAttempt(order) {
  if (backfillAttempts.size > 5000) backfillAttempts.clear();
  backfillAttempts.set(order.shopify_order_id, Date.now());
}

// Orders the dispatcher still needs to see: everything in flight, plus
// completed orders finished within the retention window. Cancelled orders are
// dropped outright — there is no delivery left to run — while the rows stay in
// the database and the orders stay in Shopify.
function queryVisibleOrders(storeId, retentionDays) {
  return pool.query(
    `SELECT * FROM orders
     WHERE store_id = $1
       AND order_status <> 'CANCELLED'
       AND (
         order_status NOT IN ('FULFILLED', 'DELIVERED')
         OR COALESCE(fulfilled_at, delivered_at, created_at) >= NOW() - make_interval(days => $2::int)
       )
     ORDER BY created_at DESC`,
    [storeId, retentionDays]
  );
}

function isMissingCustomerOrCity(order) {
  const hasCustomerName = Boolean(
    `${order.customer_first_name || ""} ${order.customer_last_name || ""}`.trim()
  );
  return !hasCustomerName || !order.city;
}

function normalizeOrderForDashboard(order) {
  return {
    ...order,
    customer_name: `${order.customer_first_name || ""} ${order.customer_last_name || ""}`.trim(),
    display_city: order.city || "",
  };
}

async function backfillMissingCustomerFields(order, storeId) {
  if (!isMissingCustomerOrCity(order)) return order;

  const fields = await fetchOrderCustomerFieldsFromShopify(storeId, order.shopify_order_id);
  if (!fields) return order;
  if (!fields.customer_first_name && !fields.customer_last_name && !fields.city) {
    console.warn(`[Shopify backfill] Order ${order.shopify_order_id} returned no customer name or city`);
    return order;
  }

  const result = await pool.query(
    `UPDATE orders
     SET customer_first_name = COALESCE($1, customer_first_name),
         customer_last_name = COALESCE($2, customer_last_name),
         customer_phone = COALESCE($3, customer_phone),
         customer_email = COALESCE($4, customer_email),
         shipping_address = COALESCE($5, shipping_address),
         city = COALESCE($6, city),
         country = COALESCE($7, country),
         total_price = COALESCE($8, total_price),
         financial_status = COALESCE($9, financial_status),
         fulfillment_status = COALESCE($10, fulfillment_status),
         -- An order that Shopify already reports as paid while it is still
         -- out for delivery was paid online. Only ever set, never cleared:
         -- once the driver delivers, 'paid' stops meaning anything here.
         prepaid = CASE
           WHEN delivered_at IS NULL
                AND LOWER(COALESCE($9, financial_status, '')) = 'paid' THEN TRUE
           ELSE prepaid
         END
     WHERE id = $11 AND store_id = $12
     RETURNING *`,
    [
      fields.customer_first_name,
      fields.customer_last_name,
      fields.customer_phone,
      fields.customer_email,
      fields.shipping_address,
      fields.city,
      fields.country,
      fields.total_price,
      fields.financial_status,
      fields.fulfillment_status,
      order.id,
      storeId,
    ]
  );

  const updatedOrder = result.rows[0] || order;
  console.info(`[Shopify backfill] Updated order ${order.shopify_order_id} customer/city`);
  return updatedOrder;
}

// Returns every order for a specific store, newest first. If the store has no
// orders at all — which happens after a re-install, since webhooks only cover
// orders placed from that point on — the Shopify history is pulled in first so
// the dashboard repopulates itself without any manual step.
async function getAllOrders(storeId) {
  const retentionDays = getRetentionDays();
  let result = await queryVisibleOrders(storeId, retentionDays);

  if (result.rows.length === 0) {
    // Distinguish "nothing imported yet" from "everything is older than the
    // retention window" — only the first case warrants a Shopify import.
    const existing = await pool.query(
      `SELECT 1 FROM orders WHERE store_id = $1 LIMIT 1`,
      [storeId]
    );
    const lastAttempt = lastAutoImportAt.get(storeId) || 0;

    if (existing.rows.length === 0 && Date.now() - lastAttempt > AUTO_IMPORT_COOLDOWN_MS) {
      lastAutoImportAt.set(storeId, Date.now());
      try {
        console.log(`[Shopify import] Store ${storeId} has no orders — auto-importing from Shopify`);
        await importOrdersFromShopify(storeId);
        result = await queryVisibleOrders(storeId, retentionDays);
      } catch (error) {
        console.error(`[Shopify import] Auto-import for store ${storeId} failed:`, error.message);
      }
    }
  }

  const rows = result.rows;
  let repairBudget = BACKFILL_PER_REQUEST;
  const repairedRows = await Promise.all(
    rows.map((order) => {
      if (!isMissingCustomerOrCity(order) || repairBudget <= 0 || !shouldAttemptBackfill(order)) {
        return order;
      }

      repairBudget -= 1;
      recordBackfillAttempt(order);
      return backfillMissingCustomerFields(order, storeId).catch((error) => {
        console.error(`[Shopify backfill] Order ${order.shopify_order_id} failed:`, error.message);
        return order;
      });
    })
  );
  return repairedRows.map(normalizeOrderForDashboard);
}

// Returns a single order by primary key, scoped to the store.
async function getOrderById(orderId, storeId) {
  const result = await pool.query(
    `SELECT * FROM orders WHERE id = $1 AND store_id = $2 LIMIT 1`,
    [orderId, storeId]
  );
  return result.rows[0];
}

// Every driver-facing read joins stores for store_name, because one delivery
// app serves several shops: the driver's WhatsApp message to the customer has
// to name which shop the order is from. LEFT JOIN, not JOIN — schema.sql notes
// that databases migrated from the pre-store_id schema can still hold orders
// with a null store_id until they are backfilled, and an inner join would drop
// those off the driver's list entirely rather than merely leaving the name
// blank. shop_domain comes along as the fallback for a store that never got a
// store_name from Shopify.
async function getOrderByIdForDriver(orderId, driverId) {
  const result = await pool.query(
    `SELECT o.*, s.store_name, s.shop_domain
     FROM orders o
     LEFT JOIN stores s ON s.id = o.store_id
     WHERE o.id = $1 AND o.assigned_driver_id = $2
     LIMIT 1`,
    [orderId, driverId]
  );
  return result.rows[0];
}

async function getDriverNameById(driverId) {
  if (!driverId) return null;

  const result = await pool.query(
    `SELECT full_name FROM drivers WHERE id = $1 LIMIT 1`,
    [driverId]
  );

  return result.rows[0]?.full_name || null;
}

// Naming the driver for an order. ASSIGNED sits before PICKED_UP in the
// journey, so it is only applied to orders that have not got there yet:
// fulfilling in the Shopify admin moves an order straight to PICKED_UP, and a
// dispatcher naming the driver afterwards must not send it backwards — the
// customer would watch their tracking page fall from "Order picked up" to
// "Order pending". Past that point only the driver is recorded.
const PRE_ASSIGNMENT_STATUSES = ["PENDING", "UNFULFILLED", "FULFILLED", "ASSIGNED"];

async function assignDriverToOrder(orderId, driverId, storeId) {
  const result = await pool.query(
    `UPDATE orders
     SET assigned_driver_id = $1,
         order_status = CASE
           WHEN order_status = ANY($4::text[]) THEN 'ASSIGNED'
           ELSE order_status
         END
     WHERE id = $2 AND store_id = $3
     RETURNING *`,
    [driverId, orderId, storeId, PRE_ASSIGNMENT_STATUSES]
  );
  const row = result.rows[0];
  if (row) {
    getDriverNameById(driverId)
      .then(driverName =>
        // Tag whatever the order actually is now, not a blanket "Assigned":
        // an order already picked up keeps its Picked Up tag in Shopify, with
        // the driver's name carried through where the tag uses it.
        syncOrderTagToShopify(storeId, row.shopify_order_id, row.order_status, { driverName })
      )
      .catch(err =>
        console.error("[Shopify sync] assign tag failed:", err.message)
      );
  }
  return row;
}

async function unassignDriverFromOrder(orderId, storeId) {
  const result = await pool.query(
    `UPDATE orders
     SET assigned_driver_id = NULL, order_status = 'UNFULFILLED'
     WHERE id = $1 AND store_id = $2
     RETURNING *`,
    [orderId, storeId]
  );
  const row = result.rows[0];
  if (row) {
    syncOrderTagToShopify(storeId, row.shopify_order_id, "UNFULFILLED").catch(err =>
      console.error("[Shopify sync] unassign tag failed:", err.message)
    );
  }
  return row;
}

// The completion timestamps double as the clock for the dashboard's retention
// window, so a status change into a finished state has to stamp one.
function statusUpdateQuery(status) {
  // financial_status is not set here: delivering records the payment in
  // Shopify first, and the local column only follows once that succeeds.
  // Delivering and fulfilling both leave a fulfillment behind in Shopify, so
  // the mirrored fulfillment_status has to follow. The dashboard's Unfulfilled
  // card counts off that column, and only PICKED_UP used to stamp it — an
  // order taken straight from ASSIGNED to DELIVERED kept a null there and went
  // on being counted as unfulfilled forever.
  if (status === "DELIVERED") {
    return `UPDATE orders SET order_status = $1, delivered_at = NOW(),
              fulfilled_at = COALESCE(fulfilled_at, NOW()),
              fulfillment_status = 'fulfilled'
            WHERE id = $2 AND store_id = $3 RETURNING *`;
  }
  if (status === "FULFILLED") {
    return `UPDATE orders SET order_status = $1, fulfilled_at = NOW(),
              fulfillment_status = 'fulfilled'
            WHERE id = $2 AND store_id = $3 RETURNING *`;
  }
  // Sending an order back to Unfulfilled cancels its fulfillment in Shopify,
  // so the mirror has to be cleared — the webhooks COALESCE a null coming back
  // from Shopify and would never unset it on their own.
  if (status === "UNFULFILLED") {
    return `UPDATE orders SET order_status = $1, fulfilled_at = NULL,
              fulfillment_status = NULL
            WHERE id = $2 AND store_id = $3 RETURNING *`;
  }
  // Cancelling releases the driver — there is nothing left for them to deliver.
  if (status === "CANCELLED") {
    return `UPDATE orders SET order_status = $1, assigned_driver_id = NULL
            WHERE id = $2 AND store_id = $3 RETURNING *`;
  }
  return `UPDATE orders SET order_status = $1
          WHERE id = $2 AND store_id = $3 RETURNING *`;
}

// The tracking token is what the customer's live tracking link is built from.
// Orders created before tokens were issued would otherwise reach Shopify with
// no link at all, so one is minted on demand.
async function ensureTrackingToken(row) {
  if (!row || row.tracking_token) return row;

  const result = await pool.query(
    `UPDATE orders SET tracking_token = $1 WHERE id = $2 AND tracking_token IS NULL
     RETURNING *`,
    [randomUUID(), row.id]
  );
  return result.rows[0] || row;
}

async function updateOrderStatus(orderId, status, storeId) {
  const result = await pool.query(statusUpdateQuery(status), [status, orderId, storeId]);
  let row = result.rows[0];
  if (row && (status === "PICKED_UP" || status === "FULFILLED" || status === "DELIVERED")) {
    row = await ensureTrackingToken(row);
  }
  if (row) {
    const driverName = ["ASSIGNED", "PICKED_UP", "DELIVERED"].includes(status)
      ? await getDriverNameById(row.assigned_driver_id)
      : null;

    syncOrderTagToShopify(storeId, row.shopify_order_id, status, { driverName }).catch(err =>
      console.error("[Shopify sync] status tag failed:", err.message)
    );
    if (status === "DELIVERED") {
      markDeliveredInShopify(storeId, row.shopify_order_id, row).catch(err =>
        console.error("[Shopify sync] mark delivered failed:", err.message)
      );
      // Delivering a cash-on-delivery order is the moment the money changes
      // hands, so record the payment in Shopify. Awaited, so the dispatcher
      // hears about it straight away if Shopify won't take it.
      try {
        const paidRow = await markOrderPaid(orderId, storeId);
        if (paidRow) row = paidRow;
      } catch (error) {
        console.error("[Shopify sync] mark paid on delivery failed:", error.message);
        row.shopify_warning =
          `Marked delivered, but Shopify was not updated to paid: ${error.message}`;
      }
    }
    if (status === "FULFILLED") {
      markFulfilledInShopify(storeId, row.shopify_order_id, row).catch(err =>
        console.error("[Shopify sync] mark fulfilled failed:", err.message)
      );
    }
    if (status === "PICKED_UP") {
      try {
        const fulfilled = await markFulfilledInShopify(storeId, row.shopify_order_id, row);
        if (fulfilled) {
          const fulfilledResult = await pool.query(
            `UPDATE orders
             SET fulfilled_at = COALESCE(fulfilled_at, NOW()),
                 fulfillment_status = 'fulfilled'
             WHERE id = $1 AND store_id = $2
             RETURNING *`,
            [row.id, storeId]
          );
          row = fulfilledResult.rows[0] || row;
        }
      } catch (error) {
        console.error("[Shopify sync] mark fulfilled on pickup failed:", error.message);
        row.shopify_warning =
          `Marked picked up, but Shopify was not fulfilled: ${error.message}`;
      }
    }
    if (status === "UNFULFILLED") {
      markUnfulfilledInShopify(storeId, row.shopify_order_id).catch(err =>
        console.error("[Shopify sync] mark unfulfilled failed:", err.message)
      );
    }
    if (status === "CANCELLED") {
      // Awaited, unlike the other syncs: Shopify refuses to cancel some orders
      // and the dispatcher needs to know straight away that the store still
      // shows it as live.
      try {
        await cancelOrderInShopify(storeId, row.shopify_order_id);
      } catch (error) {
        console.error("[Shopify sync] cancel order failed:", error.message);
        row.shopify_warning = error.message;
      }
    }
  }
  return row;
}

// Records the payment in Shopify, then mirrors it locally. Payment is a
// separate axis from the delivery lifecycle, so order_status is deliberately
// untouched — an order out with a driver stays that way once it is paid.
//
// Shopify is written first: if it refuses, the dashboard keeps showing the
// order as unpaid rather than claiming money was recorded when it wasn't.
//
// When this happens decides what it means, which is why prepaid keys off
// delivered_at:
//   - Before delivery — the dispatcher marking an order paid from the
//     dashboard means the customer settled it some other way, so the driver
//     has no cash to collect and the order earns nothing.
//   - On or after delivery — this is the cash-on-delivery payment itself,
//     either recorded automatically when the driver marks the order
//     delivered or entered by hand afterwards if that sync failed. That
//     money is real, so prepaid stays as it was.
async function markOrderPaid(orderId, storeId) {
  const order = await getOrderById(orderId, storeId);
  if (!order) return null;

  await markOrderPaidInShopify(storeId, order.shopify_order_id);

  const result = await pool.query(
    `UPDATE orders
     SET financial_status = 'paid',
         prepaid = CASE WHEN delivered_at IS NULL THEN TRUE ELSE prepaid END
     WHERE id = $1 AND store_id = $2
     RETURNING *`,
    [orderId, storeId]
  );
  return result.rows[0];
}

// Removes the order from Shopify and then from the dashboard. Shopify refuses
// to delete an order that is still open, so it is cancelled first — that call
// is best effort, because an order already cancelled reports an error the
// delete itself doesn't care about.
//
// The local row is only removed once Shopify has confirmed, so a rejected
// delete leaves the two sides in step instead of silently diverging.
async function deleteOrderEverywhere(orderId, storeId) {
  const order = await getOrderById(orderId, storeId);
  if (!order) return null;

  if (order.order_status !== "CANCELLED") {
    try {
      await cancelOrderInShopify(storeId, order.shopify_order_id);
    } catch (error) {
      console.warn(
        `[Shopify sync] Cancel before delete for order ${order.shopify_order_id} did not apply: ${error.message}`
      );
    }
  }

  await deleteOrderInShopify(storeId, order.shopify_order_id);

  await pool.query(`DELETE FROM orders WHERE id = $1 AND store_id = $2`, [orderId, storeId]);
  console.log(`[Orders] Order ${order.order_number || orderId} deleted from Shopify and the dashboard`);
  return order;
}

// Driver-scoped updates — drivers are global, no store filter needed here.
async function updateDriverOrderStatus(orderId, driverId, status) {
  const query =
    status === "DELIVERED"
      ? `UPDATE orders
         SET order_status = $1, delivered_at = NOW()
         WHERE id = $2 AND assigned_driver_id = $3
         RETURNING *,
           (SELECT full_name FROM drivers WHERE id = $3) AS driver_name`
      : `UPDATE orders
         SET order_status = $1
         WHERE id = $2 AND assigned_driver_id = $3
         RETURNING *,
           (SELECT full_name FROM drivers WHERE id = $3) AS driver_name`;

  const result = await pool.query(query, [status, orderId, driverId]);
  const row = result.rows[0];
  return status === "DELIVERED" ? ensureTrackingToken(row) : row;
}

// Saves the note the driver wrote on one of their own orders. The
// assigned_driver_id check is part of the UPDATE, so a driver cannot write on
// an order that is not theirs: a mismatch updates no row and returns undefined,
// which the controller turns into a 403/404.
//
// A null note clears the column — that is the driver deleting what they wrote.
async function updateDriverOrderNote(orderId, driverId, note) {
  const result = await pool.query(
    `UPDATE orders
     SET driver_note = $1
     WHERE id = $2 AND assigned_driver_id = $3
     RETURNING *`,
    [note, orderId, driverId]
  );
  return result.rows[0];
}

async function getOrdersByDriverId(driverId) {
  const result = await pool.query(
    `SELECT o.*, s.store_name, s.shop_domain
     FROM orders o
     LEFT JOIN stores s ON s.id = o.store_id
     WHERE o.assigned_driver_id = $1
       AND o.order_status NOT IN ('DELIVERED', 'RETURNED', 'CANCELLED')
     ORDER BY o.created_at DESC`,
    [driverId]
  );
  return result.rows;
}

async function getCompletedOrdersByDriverId(driverId) {
  const result = await pool.query(
    `SELECT o.*, s.store_name, s.shop_domain
     FROM orders o
     LEFT JOIN stores s ON s.id = o.store_id
     WHERE o.assigned_driver_id = $1
       AND o.order_status = 'DELIVERED'
     ORDER BY COALESCE(o.delivered_at, o.created_at) DESC
     LIMIT 100`,
    [driverId]
  );
  return result.rows;
}

// Orders this driver brought back. The driver app's Returned tab is built from
// this, so an order marked RETURNED is still there after the app is restarted —
// it is excluded from the assigned list (getOrdersByDriverId) and is not
// DELIVERED, so without this query the app had nowhere to read it back from and
// the tab came back empty.
//
// Ordered by created_at because a return stamps no completion timestamp of its
// own: delivered_at belongs to the delivery that never happened.
async function getReturnedOrdersByDriverId(driverId) {
  const result = await pool.query(
    `SELECT o.*, s.store_name, s.shop_domain
     FROM orders o
     LEFT JOIN stores s ON s.id = o.store_id
     WHERE o.assigned_driver_id = $1
       AND o.order_status = 'RETURNED'
     ORDER BY o.created_at DESC
     LIMIT 100`,
    [driverId]
  );
  return result.rows;
}

async function createLocationUpdate({ order_id, driver_id, latitude, longitude }) {
  const result = await pool.query(
    `INSERT INTO location_updates (order_id, driver_id, latitude, longitude)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [order_id, driver_id, latitude, longitude]
  );
  return result.rows[0];
}

// Resolves a Shopify order id to its tracking token, for the short /t/:id link
// handed to WhatsApp templates.
//
// Interakt's message templates can only carry one variable inside a URL button,
// and none of the attributes it exposes on the "order shipped" event hold our
// tracking token — but shopify_order_id is on every one of them, from "order
// placed" onwards. Resolving it here means the link in the message is built
// from something that exists the moment the order lands, so it is never empty,
// no matter who fulfils the order or when.
//
// shopify_order_id is used rather than order_number precisely because it is not
// sequential: order numbers run 1001, 1002, 1003 and would let anyone walk the
// list and read other customers' addresses and live driver positions.
//
// A token is minted on demand for orders imported before tokens existed, the
// same as ensureTrackingToken does on the status path.
async function getTrackingTokenByShopifyOrderId(shopifyOrderId) {
  const result = await pool.query(
    `SELECT id, tracking_token FROM orders WHERE shopify_order_id = $1 LIMIT 1`,
    [shopifyOrderId]
  );
  const row = result.rows[0];
  if (!row) return null;
  if (row.tracking_token) return row.tracking_token;

  const minted = await pool.query(
    `UPDATE orders SET tracking_token = $1
     WHERE id = $2 AND tracking_token IS NULL
     RETURNING tracking_token`,
    [randomUUID(), row.id]
  );
  return minted.rows[0]?.tracking_token || null;
}

// Public tracking lookup — token is globally unique, no store filter needed.
async function getOrderByTrackingToken(token) {
  const result = await pool.query(
    `SELECT
       o.id, o.order_number, o.order_status,
       o.customer_first_name, o.customer_last_name,
       o.shipping_address, o.city, o.area,
       o.customer_latitude, o.customer_longitude,
       o.assigned_driver_id,
       o.delivered_at,
       d.full_name  AS driver_name,
       d.phone      AS driver_phone,
       lu.latitude  AS driver_lat,
       lu.longitude AS driver_lng,
       lu.created_at AS location_updated_at,
       -- Age of the last ping, measured by Postgres. The ETA uses this rather
       -- than comparing timestamps in Node: location_updates.created_at has no
       -- timezone, so parsing it in the app would silently depend on the two
       -- processes agreeing about what timezone they are in.
       EXTRACT(EPOCH FROM (NOW() - lu.created_at)) AS location_age_seconds
     FROM orders o
     LEFT JOIN drivers d ON d.id = o.assigned_driver_id
     LEFT JOIN LATERAL (
       SELECT latitude, longitude, created_at
       FROM location_updates
       WHERE order_id = o.id AND driver_id = o.assigned_driver_id
       ORDER BY created_at DESC LIMIT 1
     ) lu ON TRUE
     WHERE o.tracking_token = $1
     LIMIT 1`,
    [token]
  );
  return result.rows[0];
}

// Counts the other orders this driver has started and not yet finished.
//
// "Started" means GPS is currently flowing for the order, which is what the
// driver app begins doing the moment "Start Delivery" is tapped. That is a
// truer signal than order_status: a driver can have five orders ASSIGNED and
// still be carrying only one, and only the ones actually in the vehicle should
// push a customer's ETA later.
async function countStartedDeliveries(driverId, excludeOrderId) {
  if (!driverId) return 0;

  const result = await pool.query(
    `SELECT COUNT(*)::int AS count
     FROM orders o
     WHERE o.assigned_driver_id = $1
       AND o.id <> $2
       AND o.order_status NOT IN ('DELIVERED', 'RETURNED', 'CANCELLED', 'FULFILLED')
       AND EXISTS (
         SELECT 1 FROM location_updates lu
         WHERE lu.order_id = o.id
           AND lu.created_at > NOW() - make_interval(secs => $3::int)
       )`,
    [driverId, excludeOrderId, STARTED_WINDOW_SECONDS]
  );

  return result.rows[0]?.count ?? 0;
}

async function updateCustomerLocation(orderId, lat, lng, storeId) {
  const result = await pool.query(
    `UPDATE orders
     SET customer_latitude = $1, customer_longitude = $2
     WHERE id = $3 AND store_id = $4
     RETURNING *`,
    [lat, lng, orderId, storeId]
  );
  return result.rows[0];
}

// Sets the delivery area for one order, used by the dispatcher's manual
// override. Once set by hand the value sticks: webhook replays and the import
// path both keep an existing area rather than recomputing it.
async function updateOrderArea(orderId, area, storeId) {
  const result = await pool.query(
    `UPDATE orders
     SET area = $1
     WHERE id = $2 AND store_id = $3
     RETURNING *`,
    [area, orderId, storeId]
  );
  return result.rows[0];
}

module.exports = {
  getAllOrders,
  getOrderById,
  getOrderByIdForDriver,
  assignDriverToOrder,
  unassignDriverFromOrder,
  updateOrderStatus,
  markOrderPaid,
  deleteOrderEverywhere,
  updateDriverOrderStatus,
  updateDriverOrderNote,
  getOrdersByDriverId,
  getCompletedOrdersByDriverId,
  getReturnedOrdersByDriverId,
  createLocationUpdate,
  getOrderByTrackingToken,
  getTrackingTokenByShopifyOrderId,
  countStartedDeliveries,
  updateCustomerLocation,
  updateOrderArea,
};
