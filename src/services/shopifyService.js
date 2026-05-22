const pool = require("../config/db");

const SHOPIFY_API_VERSION = "2024-01";

const STATUS_TAG_MAP = {
  PENDING:          "delivery-pending",
  ASSIGNED:         "delivery-assigned",
  PICKED_UP:        "delivery-picked-up",
  OUT_FOR_DELIVERY: "delivery-out-for-delivery",
  DELIVERED:        "delivery-delivered",
  CANCELLED:        "delivery-cancelled",
};

async function getStoreCredentials(storeId) {
  const result = await pool.query(
    `SELECT shop_domain, access_token, scope FROM stores WHERE id = $1 LIMIT 1`,
    [storeId]
  );
  return result.rows[0] || null;
}

// Updates the delivery-* tag on a Shopify order to reflect the current status.
async function syncOrderTagToShopify(storeId, shopifyOrderId, status) {
  if (!shopifyOrderId) return;

  const store = await getStoreCredentials(storeId);
  if (!store) {
    console.warn(`[Shopify sync] Store ${storeId} not found`);
    return;
  }
  if (!store.scope || !store.scope.includes("write_orders")) {
    console.warn(`[Shopify sync] Store ${storeId} lacks write_orders scope — re-install needed`);
    return;
  }

  const { shop_domain, access_token } = store;
  const headers = {
    "Content-Type": "application/json",
    "X-Shopify-Access-Token": access_token,
  };
  const base = `https://${shop_domain}/admin/api/${SHOPIFY_API_VERSION}`;

  // Fetch current tags
  const getRes = await fetch(
    `${base}/orders/${shopifyOrderId}.json?fields=id,tags`,
    { headers }
  );
  if (!getRes.ok) {
    console.error(`[Shopify sync] GET order ${shopifyOrderId} failed: ${getRes.status}`);
    return;
  }
  const { order } = await getRes.json();

  // Replace any existing delivery-* tag with the new one
  const deliveryTag = STATUS_TAG_MAP[status];
  const existingTags = order.tags
    ? order.tags.split(",").map(t => t.trim()).filter(t => !t.startsWith("delivery-"))
    : [];
  if (deliveryTag) existingTags.push(deliveryTag);
  const newTags = existingTags.join(", ");

  const putRes = await fetch(`${base}/orders/${shopifyOrderId}.json`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ order: { id: shopifyOrderId, tags: newTags } }),
  });
  if (!putRes.ok) {
    console.error(`[Shopify sync] PUT order ${shopifyOrderId} tags failed: ${putRes.status}`);
    return;
  }
  console.log(`[Shopify sync] Order ${shopifyOrderId} tagged "${deliveryTag}"`);
}

// Creates a Shopify fulfillment for the order, marking it as fulfilled.
// Called only when status transitions to DELIVERED.
async function fulfillShopifyOrder(storeId, shopifyOrderId) {
  if (!shopifyOrderId) return;

  const store = await getStoreCredentials(storeId);
  if (!store) return;
  if (!store.scope || !store.scope.includes("write_fulfillments")) {
    console.warn(`[Shopify sync] Store ${storeId} lacks write_fulfillments scope — re-install needed`);
    return;
  }

  const { shop_domain, access_token } = store;
  const headers = {
    "Content-Type": "application/json",
    "X-Shopify-Access-Token": access_token,
  };
  const base = `https://${shop_domain}/admin/api/${SHOPIFY_API_VERSION}`;

  // Get open fulfillment orders
  const foRes = await fetch(
    `${base}/orders/${shopifyOrderId}/fulfillment_orders.json`,
    { headers }
  );
  if (!foRes.ok) {
    console.error(`[Shopify sync] GET fulfillment_orders failed: ${foRes.status}`);
    return;
  }
  const { fulfillment_orders } = await foRes.json();
  const open = (fulfillment_orders || []).filter(fo =>
    fo.status === "open" || fo.status === "in_progress"
  );

  if (open.length === 0) {
    console.log(`[Shopify sync] Order ${shopifyOrderId} already fulfilled or has no open fulfillment orders`);
    return;
  }

  const fulfillRes = await fetch(`${base}/fulfillments.json`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      fulfillment: {
        line_items_by_fulfillment_order: open.map(fo => ({
          fulfillment_order_id: fo.id,
        })),
        notify_customer: false,
      },
    }),
  });
  if (!fulfillRes.ok) {
    const body = await fulfillRes.text();
    console.error(`[Shopify sync] Create fulfillment failed: ${fulfillRes.status} ${body}`);
    return;
  }
  console.log(`[Shopify sync] Order ${shopifyOrderId} marked fulfilled in Shopify`);
}

module.exports = { syncOrderTagToShopify, fulfillShopifyOrder };
