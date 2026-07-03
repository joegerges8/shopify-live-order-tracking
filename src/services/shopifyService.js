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

function firstNonBlank(...values) {
  for (const value of values) {
    if (value === null || value === undefined) continue;
    const trimmed = String(value).trim();
    if (trimmed.length) return trimmed;
  }
  return null;
}

function getNoteAttribute(order, key) {
  const normalizedKey = String(key).trim().toLowerCase();
  const noteAttributes = Array.isArray(order.note_attributes) ? order.note_attributes : [];
  const match = noteAttributes.find((item) => String(item.name || "").trim().toLowerCase() === normalizedKey);
  return match ? match.value : null;
}

function getAnyNoteAttribute(order, keys) {
  for (const key of keys) {
    const value = firstNonBlank(getNoteAttribute(order, key));
    if (value) return value;
  }
  return null;
}

function splitName(name) {
  const normalized = firstNonBlank(name);
  if (!normalized) return { firstName: null, lastName: null };

  const parts = normalized.split(/\s+/);
  return {
    firstName: parts[0] || null,
    lastName: parts.length > 1 ? parts.slice(1).join(" ") : null,
  };
}

function getAddressCandidates(order) {
  return [
    order.shipping_address,
    order.billing_address,
    order.customer?.default_address,
    ...(Array.isArray(order.customer?.addresses) ? order.customer.addresses : []),
  ].filter(Boolean);
}

function extractOrderCustomerFields(order) {
  const addresses = getAddressCandidates(order);
  const addressName = splitName(firstNonBlank(...addresses.map((address) => address.name)));
  const noteName = splitName(getAnyNoteAttribute(order, [
    "customer_name",
    "customer name",
    "full_name",
    "full name",
    "name",
  ]));
  const firstName = firstNonBlank(
    order.customer?.first_name,
    ...addresses.map((address) => address.first_name),
    addressName.firstName,
    getAnyNoteAttribute(order, ["first_name", "first name"]),
    noteName.firstName
  );
  const lastName = firstNonBlank(
    order.customer?.last_name,
    ...addresses.map((address) => address.last_name),
    addressName.lastName,
    getAnyNoteAttribute(order, ["last_name", "last name"]),
    noteName.lastName
  );
  const address = addresses[0];
  const shippingAddress = address
    ? [address.address1, address.address2].filter(Boolean).join(", ") || null
    : null;

  return {
    customer_first_name: firstName,
    customer_last_name: lastName,
    customer_phone: firstNonBlank(
      order.phone,
      order.customer?.phone,
      ...addresses.map((item) => item.phone)
    ),
    customer_email: firstNonBlank(order.email, order.customer?.email),
    shipping_address: shippingAddress,
    city: firstNonBlank(
      ...addresses.map((item) => item.city),
      getAnyNoteAttribute(order, ["city", "delivery_city", "delivery city", "shipping_city", "shipping city"])
    ),
    country: firstNonBlank(...addresses.map((item) => item.country)),
    total_price: order.total_price ?? null,
    financial_status: order.financial_status ?? null,
    fulfillment_status: order.fulfillment_status ?? null,
  };
}

async function fetchOrderCustomerFieldsFromShopify(storeId, shopifyOrderId) {
  if (!shopifyOrderId) return null;

  const store = await getStoreCredentials(storeId);
  if (!store || !store.access_token) return null;
  if (!store.scope || !store.scope.includes("read_orders")) {
    console.warn(`[Shopify backfill] Store ${storeId} lacks read_orders scope`);
    return null;
  }

  const fields = [
    "id",
    "name",
    "order_number",
    "email",
    "phone",
    "customer",
    "shipping_address",
    "billing_address",
    "note_attributes",
    "total_price",
    "financial_status",
    "fulfillment_status",
  ].join(",");
  const url = `https://${store.shop_domain}/admin/api/${SHOPIFY_API_VERSION}/orders/${shopifyOrderId}.json?fields=${fields}`;
  const response = await fetch(url, {
    headers: { "X-Shopify-Access-Token": store.access_token },
  });

  if (!response.ok) {
    console.error(`[Shopify backfill] GET order ${shopifyOrderId} failed: ${response.status}`);
    return null;
  }

  const { order } = await response.json();
  return order ? extractOrderCustomerFields(order) : null;
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

module.exports = { syncOrderTagToShopify, markDeliveredInShopify, fetchOrderCustomerFieldsFromShopify };
