const pool = require("../config/db");
const {
  syncOrderTagToShopify,
  markDeliveredInShopify,
  markFulfilledInShopify,
  markUnfulfilledInShopify,
  fetchOrderCustomerFieldsFromShopify,
  importOrdersFromShopify,
} = require("./shopifyService");

// Guards the empty-dashboard auto-import so a store whose import keeps failing
// doesn't hit Shopify on every page load.
const lastAutoImportAt = new Map();
const AUTO_IMPORT_COOLDOWN_MS = 5 * 60 * 1000;

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
  let result = await pool.query(
    `SELECT * FROM orders WHERE store_id = $1 ORDER BY created_at DESC`,
    [storeId]
  );

  if (result.rows.length === 0) {
    const lastAttempt = lastAutoImportAt.get(storeId) || 0;
    if (Date.now() - lastAttempt > AUTO_IMPORT_COOLDOWN_MS) {
      lastAutoImportAt.set(storeId, Date.now());
      try {
        console.log(`[Shopify import] Store ${storeId} has no orders — auto-importing from Shopify`);
        await importOrdersFromShopify(storeId);
        result = await pool.query(
          `SELECT * FROM orders WHERE store_id = $1 ORDER BY created_at DESC`,
          [storeId]
        );
      } catch (error) {
        console.error(`[Shopify import] Auto-import for store ${storeId} failed:`, error.message);
      }
    }
  }

  const rows = result.rows;
  let repairBudget = 25;
  const repairedRows = await Promise.all(
    rows.map((order) => {
      if (!isMissingCustomerOrCity(order) || repairBudget <= 0) {
        return order;
      }

      repairBudget -= 1;
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

async function updateOrderStatus(orderId, status, storeId) {
  const query =
    status === "DELIVERED"
      ? `UPDATE orders SET order_status = $1, delivered_at = NOW(), financial_status = 'paid'
         WHERE id = $2 AND store_id = $3 RETURNING *`
      : `UPDATE orders SET order_status = $1
         WHERE id = $2 AND store_id = $3 RETURNING *`;

  const result = await pool.query(query, [status, orderId, storeId]);
  const row = result.rows[0];
  if (row) {
    syncOrderTagToShopify(storeId, row.shopify_order_id, status).catch(err =>
      console.error("[Shopify sync] status tag failed:", err.message)
    );
    if (status === "DELIVERED") {
      markDeliveredInShopify(storeId, row.shopify_order_id).catch(err =>
        console.error("[Shopify sync] mark delivered failed:", err.message)
      );
    }
    if (status === "FULFILLED") {
      markFulfilledInShopify(storeId, row.shopify_order_id).catch(err =>
        console.error("[Shopify sync] mark fulfilled failed:", err.message)
      );
    }
    if (status === "PENDING") {
      markUnfulfilledInShopify(storeId, row.shopify_order_id).catch(err =>
        console.error("[Shopify sync] mark unfulfilled failed:", err.message)
      );
    }
  }
  return row;
}

// Driver-scoped updates — drivers are global, no store filter needed here.
async function updateDriverOrderStatus(orderId, driverId, status) {
  const query =
    status === "DELIVERED"
      ? `UPDATE orders
         SET order_status = $1, delivered_at = NOW(), financial_status = 'paid'
         WHERE id = $2 AND assigned_driver_id = $3
         RETURNING *`
      : `UPDATE orders
         SET order_status = $1
         WHERE id = $2 AND assigned_driver_id = $3
         RETURNING *`;

  const result = await pool.query(query, [status, orderId, driverId]);
  return result.rows[0];
}

async function getOrdersByDriverId(driverId) {
  const result = await pool.query(
    `SELECT * FROM orders
     WHERE assigned_driver_id = $1
       AND order_status NOT IN ('DELIVERED', 'CANCELLED')
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
  updateDriverOrderStatus,
  getOrdersByDriverId,
  getCompletedOrdersByDriverId,
  createLocationUpdate,
  getOrderByTrackingToken,
  updateCustomerLocation,
};
