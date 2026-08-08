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
         fulfillment_status = COALESCE($10, fulfillment_status)
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

async function getOrderByIdForDriver(orderId, driverId) {
  const result = await pool.query(
    `SELECT * FROM orders WHERE id = $1 AND assigned_driver_id = $2 LIMIT 1`,
    [orderId, driverId]
  );
  return result.rows[0];
}

async function assignDriverToOrder(orderId, driverId, storeId) {
  const result = await pool.query(
    `UPDATE orders
     SET assigned_driver_id = $1, order_status = 'ASSIGNED'
     WHERE id = $2 AND store_id = $3
     RETURNING *`,
    [driverId, orderId, storeId]
  );
  const row = result.rows[0];
  if (row) {
    syncOrderTagToShopify(storeId, row.shopify_order_id, "ASSIGNED").catch(err =>
      console.error("[Shopify sync] assign tag failed:", err.message)
    );
  }
  return row;
}

async function unassignDriverFromOrder(orderId, storeId) {
  const result = await pool.query(
    `UPDATE orders
     SET assigned_driver_id = NULL, order_status = 'PENDING'
     WHERE id = $1 AND store_id = $2
     RETURNING *`,
    [orderId, storeId]
  );
  const row = result.rows[0];
  if (row) {
    syncOrderTagToShopify(storeId, row.shopify_order_id, "PENDING").catch(err =>
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
  if (status === "DELIVERED") {
    return `UPDATE orders SET order_status = $1, delivered_at = NOW()
            WHERE id = $2 AND store_id = $3 RETURNING *`;
  }
  if (status === "FULFILLED") {
    return `UPDATE orders SET order_status = $1, fulfilled_at = NOW()
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
  if (row && (status === "FULFILLED" || status === "DELIVERED")) {
    row = await ensureTrackingToken(row);
  }
  if (row) {
    syncOrderTagToShopify(storeId, row.shopify_order_id, status).catch(err =>
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
    if (status === "PENDING") {
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
async function markOrderPaid(orderId, storeId) {
  const order = await getOrderById(orderId, storeId);
  if (!order) return null;

  await markOrderPaidInShopify(storeId, order.shopify_order_id);

  const result = await pool.query(
    `UPDATE orders SET financial_status = 'paid'
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
         RETURNING *`
      : `UPDATE orders
         SET order_status = $1
         WHERE id = $2 AND assigned_driver_id = $3
         RETURNING *`;

  const result = await pool.query(query, [status, orderId, driverId]);
  const row = result.rows[0];
  return status === "DELIVERED" ? ensureTrackingToken(row) : row;
}

async function getOrdersByDriverId(driverId) {
  const result = await pool.query(
    `SELECT * FROM orders
     WHERE assigned_driver_id = $1
       AND order_status NOT IN ('DELIVERED', 'RETURNED', 'CANCELLED')
     ORDER BY created_at DESC`,
    [driverId]
  );
  return result.rows;
}

async function getCompletedOrdersByDriverId(driverId) {
  const result = await pool.query(
    `SELECT * FROM orders
     WHERE assigned_driver_id = $1
       AND order_status = 'DELIVERED'
     ORDER BY COALESCE(delivered_at, created_at) DESC
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

// Public tracking lookup — token is globally unique, no store filter needed.
async function getOrderByTrackingToken(token) {
  const result = await pool.query(
    `SELECT
       o.id, o.order_number, o.order_status,
       o.customer_first_name, o.customer_last_name,
       o.shipping_address, o.city,
       o.customer_latitude, o.customer_longitude,
       o.delivered_at,
       d.full_name  AS driver_name,
       d.phone      AS driver_phone,
       lu.latitude  AS driver_lat,
       lu.longitude AS driver_lng,
       lu.created_at AS location_updated_at
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
  getOrdersByDriverId,
  getCompletedOrdersByDriverId,
  createLocationUpdate,
  getOrderByTrackingToken,
  updateCustomerLocation,
};
