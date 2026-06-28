const pool = require("../config/db");

const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || "2026-04";

const STATUS_TAG_MAP = {
  PENDING:   "delivery-pending",
  ASSIGNED:  "delivery-assigned",
  PICKED_UP: "delivery-picked-up",
  CANCELLED: "delivery-cancelled",
};

async function getStoreCredentials(storeId) {
  const result = await pool.query(
    `SELECT shop_domain, access_token, scope FROM stores WHERE id = $1 LIMIT 1`,
    [storeId]
  );
  return result.rows[0] || null;
}

async function syncOrderTagToShopify(storeId, shopifyOrderId, status) {
  if (!shopifyOrderId || !STATUS_TAG_MAP[status]) return;

  const store = await getStoreCredentials(storeId);
  if (!store) return;
  if (!store.scope || !store.scope.includes("write_orders")) {
    console.warn(`[Shopify sync] Store ${storeId} lacks write_orders scope — re-install needed`);
    return;
  }

  const { shop_domain, access_token } = store;
  const headers = { "Content-Type": "application/json", "X-Shopify-Access-Token": access_token };
  const base = `https://${shop_domain}/admin/api/${SHOPIFY_API_VERSION}`;

  const getRes = await fetch(`${base}/orders/${shopifyOrderId}.json?fields=id,tags`, { headers });
  if (!getRes.ok) {
    console.error(`[Shopify sync] GET order ${shopifyOrderId} failed: ${getRes.status}`);
    return;
  }
  const { order } = await getRes.json();

  const deliveryTag = STATUS_TAG_MAP[status];
  const existingTags = order.tags
    ? order.tags.split(",").map(t => t.trim()).filter(t => t && !t.startsWith("delivery-"))
    : [];
  existingTags.push(deliveryTag);

  const putRes = await fetch(`${base}/orders/${shopifyOrderId}.json`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ order: { id: shopifyOrderId, tags: existingTags.join(", ") } }),
  });
  if (!putRes.ok) {
    console.error(`[Shopify sync] PUT tags failed: ${putRes.status}`);
    return;
  }
  console.log(`[Shopify sync] Order ${shopifyOrderId} tagged "${deliveryTag}"`);
}

// Marks a Shopify order as "Delivered" — the same as clicking Mark as → Delivered
// in the Shopify admin. Steps:
//   1. Find or create a fulfillment on the order
//   2. Post a fulfillment event with status "delivered"
async function markDeliveredInShopify(storeId, shopifyOrderId) {
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

  // Step 1: Check for an existing fulfillment
  let fulfillmentId = null;
  const existingRes = await fetch(`${base}/orders/${shopifyOrderId}/fulfillments.json`, { headers });
  if (existingRes.ok) {
    const { fulfillments } = await existingRes.json();
    if (fulfillments && fulfillments.length > 0) {
      fulfillmentId = fulfillments[0].id;
    }
  }

  // Step 2: No fulfillment yet — create one via the fulfillment orders API
  if (!fulfillmentId) {
    const foRes = await fetch(`${base}/orders/${shopifyOrderId}/fulfillment_orders.json`, { headers });
    if (!foRes.ok) {
      console.error(`[Shopify sync] GET fulfillment_orders failed: ${foRes.status}`);
      return;
    }
    const { fulfillment_orders } = await foRes.json();
    const open = (fulfillment_orders || []).filter(fo =>
      fo.status === "open" || fo.status === "in_progress"
    );
    if (open.length === 0) {
      console.log(`[Shopify sync] Order ${shopifyOrderId} has no open fulfillment orders`);
      return;
    }
    const createRes = await fetch(`${base}/fulfillments.json`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        fulfillment: {
          line_items_by_fulfillment_order: open.map(fo => ({ fulfillment_order_id: fo.id })),
          notify_customer: false,
        },
      }),
    });
    if (!createRes.ok) {
      const body = await createRes.text();
      console.error(`[Shopify sync] Create fulfillment failed: ${createRes.status} ${body}`);
      return;
    }
    const { fulfillment } = await createRes.json();
    fulfillmentId = fulfillment.id;
  }

  // Step 3: Add a "delivered" shipment event — this is what flips Shopify to "Delivered"
  const eventRes = await fetch(
    `${base}/orders/${shopifyOrderId}/fulfillments/${fulfillmentId}/events.json`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ event: { status: "delivered" } }),
    }
  );
  if (!eventRes.ok) {
    const body = await eventRes.text();
    console.error(`[Shopify sync] Fulfillment event failed: ${eventRes.status} ${body}`);
    return;
  }
  console.log(`[Shopify sync] Order ${shopifyOrderId} marked as Delivered in Shopify`);
}

module.exports = { syncOrderTagToShopify, markDeliveredInShopify };
