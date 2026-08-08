const pool = require("../config/db");
const { randomUUID } = require("crypto");
const { getStoreAccess } = require("./shopifyTokens");

const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || "2026-04";

// Where the customer-facing live tracking page is served from. Same origin as
// the rest of the app, so the OAuth APP_URL is reused.
const APP_URL = (process.env.APP_URL || "https://shopify-live-order-tracking-production.up.railway.app")
  .replace(/\/$/, "");

// Shown in Shopify as "<company> tracking: <number>", the same slot Wakilni
// and other carriers occupy on the order page.
const TRACKING_COMPANY = process.env.TRACKING_COMPANY_NAME || "DispatchHQ";

// Attaching tracking makes Shopify send its shipping confirmation email with
// the link in it. Set SHOPIFY_NOTIFY_CUSTOMER=false to stay silent.
const NOTIFY_CUSTOMER = process.env.SHOPIFY_NOTIFY_CUSTOMER !== "false";

const STATUS_TAG_MAP = {
  PENDING:   "delivery-pending",
  ASSIGNED:  "delivery-assigned",
  PICKED_UP: "delivery-picked-up",
  RETURNED:  "delivery-returned",
  CANCELLED: "delivery-cancelled",
};

// Every Shopify call in this file goes through here, so token migration and
// refresh happen automatically wherever the app talks to the Admin API.
async function getStoreCredentials(storeId) {
  return getStoreAccess(storeId);
}

function hasScope(scope, requiredScope) {
  return String(scope || "")
    .split(",")
    .map((item) => item.trim())
    .includes(requiredScope);
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
  if (!hasScope(store.scope, "read_orders") && !hasScope(store.scope, "write_orders")) {
    console.warn(`[Shopify backfill] Store ${storeId} saved scope is missing order access; trying Shopify anyway`);
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
  if (!store || !store.access_token) return;
  if (!hasScope(store.scope, "write_orders")) {
    console.warn(`[Shopify sync] Store ${storeId} saved scope is missing write_orders — trying anyway; re-install if calls fail`);
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

// Builds the live tracking link Shopify will show on the order and put in the
// shipping confirmation email. Apps like Interakt read this field, which is how
// the link reaches the customer on WhatsApp.
function buildTrackingInfo(order) {
  const token = order?.tracking_token;
  if (!token) return null;

  return {
    company: TRACKING_COMPANY,
    number: String(order.order_number || token).replace(/^#/, ""),
    url: `${APP_URL}/track/track.html?token=${encodeURIComponent(token)}`,
  };
}

// Adds the tracking link to a fulfillment that has none. A fulfillment that
// already carries tracking belongs to another carrier — Wakilni, say — so it
// is left alone rather than having its details overwritten.
async function addTrackingToFulfillment(base, headers, fulfillment, trackingInfo) {
  if (!trackingInfo) return;
  if (fulfillment.tracking_number || fulfillment.tracking_url) return;

  const response = await fetch(`${base}/fulfillments/${fulfillment.id}/update_tracking.json`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      fulfillment: { notify_customer: NOTIFY_CUSTOMER, tracking_info: trackingInfo },
    }),
  });

  if (!response.ok) {
    const body = (await response.text()).slice(0, 300);
    console.error(`[Shopify sync] Update tracking failed: ${response.status} ${body}`);
    return;
  }
  console.log(`[Shopify sync] Tracking link added to fulfillment ${fulfillment.id}`);
}

// Finds an existing fulfillment on the order, or creates one covering all
// open fulfillment orders. Creating a fulfillment is what flips Shopify's
// Fulfillment status from "Unfulfilled" to "Fulfilled".
async function ensureFulfillment(base, headers, shopifyOrderId, order) {
  const trackingInfo = buildTrackingInfo(order);

  const existingRes = await fetch(`${base}/orders/${shopifyOrderId}/fulfillments.json`, { headers });
  if (existingRes.ok) {
    const { fulfillments } = await existingRes.json();
    const active = (fulfillments || []).filter(f =>
      f.status !== "cancelled" && f.status !== "error" && f.status !== "failure"
    );
    if (active.length > 0) {
      // Backfills orders fulfilled before tracking links existed.
      await addTrackingToFulfillment(base, headers, active[0], trackingInfo);
      return active[0].id;
    }
  }

  const foRes = await fetch(`${base}/orders/${shopifyOrderId}/fulfillment_orders.json`, { headers });
  if (!foRes.ok) {
    const body = await foRes.text();
    console.error(
      `[Shopify sync] GET fulfillment_orders failed: ${foRes.status} ${body} — ` +
      `a 403 here means the app token is missing the read/write_merchant_managed_fulfillment_orders scopes (re-install the app)`
    );
    return null;
  }
  const { fulfillment_orders } = await foRes.json();
  const open = (fulfillment_orders || []).filter(fo =>
    fo.status === "open" || fo.status === "in_progress"
  );
  if (open.length === 0) {
    console.log(`[Shopify sync] Order ${shopifyOrderId} has no open fulfillment orders`);
    return null;
  }
  const createRes = await fetch(`${base}/fulfillments.json`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      fulfillment: {
        line_items_by_fulfillment_order: open.map(fo => ({ fulfillment_order_id: fo.id })),
        // Sending the notification is what puts the tracking link in the
        // customer's shipping confirmation email.
        notify_customer: NOTIFY_CUSTOMER,
        ...(trackingInfo ? { tracking_info: trackingInfo } : {}),
      },
    }),
  });
  if (!createRes.ok) {
    const body = await createRes.text();
    console.error(`[Shopify sync] Create fulfillment failed: ${createRes.status} ${body}`);
    return null;
  }
  const { fulfillment } = await createRes.json();
  return fulfillment.id;
}

async function getShopifyWriteContext(storeId) {
  const store = await getStoreCredentials(storeId);
  if (!store || !store.access_token) return null;
  // Warn (but still try) if the saved scope looks incomplete — the DB copy can
  // be stale, so let Shopify's response be the real authority.
  if (!hasScope(store.scope, "write_fulfillments")) {
    console.warn(`[Shopify sync] Store ${storeId} saved scope is missing write_fulfillments — trying anyway; re-install if calls fail`);
  }
  if (!hasScope(store.scope, "write_merchant_managed_fulfillment_orders")) {
    console.warn(`[Shopify sync] Store ${storeId} saved scope is missing write_merchant_managed_fulfillment_orders — trying anyway; re-install if calls fail`);
  }
  const { shop_domain, access_token } = store;
  return {
    base: `https://${shop_domain}/admin/api/${SHOPIFY_API_VERSION}`,
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": access_token },
  };
}

// Marks a Shopify order as "Delivered" — the same as clicking Mark as → Delivered
// in the Shopify admin. Ensures a fulfillment exists, then posts a "delivered"
// shipment event on it.
async function markDeliveredInShopify(storeId, shopifyOrderId, order) {
  if (!shopifyOrderId) return;

  const ctx = await getShopifyWriteContext(storeId);
  if (!ctx) return;
  const { base, headers } = ctx;

  const fulfillmentId = await ensureFulfillment(base, headers, shopifyOrderId, order);
  if (!fulfillmentId) return;

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

// Marks a Shopify order as "Fulfilled" — creates a fulfillment covering all
// open fulfillment orders, same as clicking Mark as → Fulfilled in the admin.
async function markFulfilledInShopify(storeId, shopifyOrderId, order) {
  if (!shopifyOrderId) return;

  const ctx = await getShopifyWriteContext(storeId);
  if (!ctx) return;
  const { base, headers } = ctx;

  const fulfillmentId = await ensureFulfillment(base, headers, shopifyOrderId, order);
  if (!fulfillmentId) return;
  console.log(`[Shopify sync] Order ${shopifyOrderId} marked as Fulfilled in Shopify`);
}

// Cancels the order in Shopify — the same as clicking Cancel order in the
// admin. No refund is issued: cancelling stops the order, and refunding money
// is a separate decision the merchant makes in Shopify.
//
// Shopify refuses to cancel an order that is both paid and fulfilled, so the
// caller gets a descriptive error rather than a silent no-op.
async function cancelOrderInShopify(storeId, shopifyOrderId) {
  if (!shopifyOrderId) return;

  const store = await getStoreCredentials(storeId);
  if (!store || !store.access_token) {
    throw new Error(`Store ${storeId} has no Shopify access token — re-install the app.`);
  }
  if (!hasScope(store.scope, "write_orders")) {
    console.warn(`[Shopify sync] Store ${storeId} saved scope is missing write_orders — trying anyway`);
  }

  const base = `https://${store.shop_domain}/admin/api/${SHOPIFY_API_VERSION}`;
  const headers = {
    "Content-Type": "application/json",
    "X-Shopify-Access-Token": store.access_token,
  };

  const response = await fetch(`${base}/orders/${shopifyOrderId}/cancel.json`, {
    method: "POST",
    headers,
    body: JSON.stringify({ reason: "other", email: false }),
  });

  if (!response.ok) {
    const body = (await response.text()).slice(0, 300);
    // 422 is Shopify's "this order can't be cancelled" — paid and fulfilled
    // orders have to be refunded or restocked by hand in the admin.
    if (response.status === 422) {
      throw new Error(
        `Shopify would not cancel this order (it may already be paid and fulfilled, ` +
        `or already cancelled). Cancel it from the Shopify admin instead. Details: ${body}`
      );
    }
    throw new Error(`Shopify cancel returned ${response.status}: ${body}`);
  }

  console.log(`[Shopify sync] Order ${shopifyOrderId} cancelled in Shopify`);
}

const MARK_AS_PAID_MUTATION = `
  mutation orderMarkAsPaid($input: OrderMarkAsPaidInput!) {
    orderMarkAsPaid(input: $input) {
      order { id name displayFinancialStatus }
      userErrors { field message }
    }
  }`;

// Records payment against the order, the same as Mark as paid in the Shopify
// admin. This is the flow for money collected outside checkout — cash on
// delivery — where Shopify holds the order as Payment pending until told.
//
// Only the payment side is touched: fulfillment and the delivery status are
// left exactly as they are.
async function markOrderPaidInShopify(storeId, shopifyOrderId) {
  if (!shopifyOrderId) return null;

  const store = await getStoreCredentials(storeId);
  if (!store || !store.access_token) {
    throw new Error(`Store ${storeId} has no Shopify access token — re-install the app.`);
  }
  if (!hasScope(store.scope, "write_orders")) {
    console.warn(`[Shopify sync] Store ${storeId} saved scope is missing write_orders — trying anyway`);
  }

  const response = await fetch(
    `https://${store.shop_domain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": store.access_token,
      },
      body: JSON.stringify({
        query: MARK_AS_PAID_MUTATION,
        variables: { input: { id: `gid://shopify/Order/${shopifyOrderId}` } },
      }),
    }
  );

  if (!response.ok) {
    const body = (await response.text()).slice(0, 300);
    throw new Error(`Shopify mark-as-paid returned ${response.status}: ${body}`);
  }

  const payload = await response.json();
  if (payload.errors?.length) {
    throw new Error(`Shopify rejected the mark-as-paid request: ${payload.errors[0].message}`);
  }

  const result = payload.data?.orderMarkAsPaid;
  const financialStatus = result?.order?.displayFinancialStatus || null;

  if (result?.userErrors?.length) {
    // Shopify refuses when there is nothing outstanding, which includes an
    // order that is already paid — that is the state we wanted, so treat it as
    // done rather than an error.
    if (financialStatus === "PAID") {
      console.log(`[Shopify sync] Order ${shopifyOrderId} was already paid in Shopify`);
      return financialStatus;
    }
    throw new Error(
      `Shopify would not mark this order as paid: ${result.userErrors[0].message} ` +
      `(the order may have no outstanding balance, or the payment is handled by a gateway).`
    );
  }

  console.log(`[Shopify sync] Order ${shopifyOrderId} marked as paid in Shopify (${financialStatus})`);
  return financialStatus;
}

// Permanently deletes the order from Shopify. This is irreversible, and
// Shopify only permits it for certain orders — anything that went through an
// online payment gateway can be cancelled but never deleted.
//
// An order that is already gone from Shopify (404) counts as success, so a
// half-finished delete can be retried without getting stuck.
async function deleteOrderInShopify(storeId, shopifyOrderId) {
  if (!shopifyOrderId) return;

  const store = await getStoreCredentials(storeId);
  if (!store || !store.access_token) {
    throw new Error(`Store ${storeId} has no Shopify access token — re-install the app.`);
  }

  const base = `https://${store.shop_domain}/admin/api/${SHOPIFY_API_VERSION}`;
  const response = await fetch(`${base}/orders/${shopifyOrderId}.json`, {
    method: "DELETE",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": store.access_token,
    },
  });

  if (response.status === 404) {
    console.log(`[Shopify sync] Order ${shopifyOrderId} already absent from Shopify`);
    return;
  }
  if (!response.ok) {
    const body = (await response.text()).slice(0, 300);
    if (response.status === 403 || response.status === 422 || response.status === 406) {
      throw new Error(
        `Shopify will not delete this order. Orders paid through an online payment ` +
        `gateway can only be cancelled, never deleted. Details: ${body}`
      );
    }
    throw new Error(`Shopify delete returned ${response.status}: ${body}`);
  }

  console.log(`[Shopify sync] Order ${shopifyOrderId} deleted from Shopify`);
}

// Reverts a Shopify order back to "Unfulfilled" by cancelling any open
// fulfillments on it.
async function markUnfulfilledInShopify(storeId, shopifyOrderId) {
  if (!shopifyOrderId) return;

  const ctx = await getShopifyWriteContext(storeId);
  if (!ctx) return;
  const { base, headers } = ctx;

  const listRes = await fetch(`${base}/orders/${shopifyOrderId}/fulfillments.json`, { headers });
  if (!listRes.ok) {
    console.error(`[Shopify sync] GET fulfillments failed: ${listRes.status}`);
    return;
  }
  const { fulfillments } = await listRes.json();
  const cancellable = (fulfillments || []).filter(f =>
    f.status !== "cancelled" && f.status !== "error"
  );
  if (cancellable.length === 0) {
    console.log(`[Shopify sync] Order ${shopifyOrderId} has no fulfillments to cancel`);
    return;
  }

  for (const fulfillment of cancellable) {
    const cancelRes = await fetch(
      `${base}/fulfillments/${fulfillment.id}/cancel.json`,
      { method: "POST", headers }
    );
    if (!cancelRes.ok) {
      const body = await cancelRes.text();
      console.error(`[Shopify sync] Cancel fulfillment ${fulfillment.id} failed: ${cancelRes.status} ${body}`);
    }
  }
  console.log(`[Shopify sync] Order ${shopifyOrderId} reverted to Unfulfilled in Shopify`);
}

// Maps a Shopify order's state to the dashboard's delivery lifecycle for
// newly imported rows. Existing rows keep whatever status the dispatcher set.
function mapImportedOrderStatus(order) {
  if (order.cancelled_at) return "CANCELLED";
  if (order.fulfillment_status === "fulfilled") return "FULFILLED";
  return "PENDING";
}

// When Shopify already fulfilled an order, keep the date it happened so the
// dashboard's retention window measures from the real event rather than from
// the moment the order was imported.
function getFulfilledAt(order) {
  const fulfillments = Array.isArray(order.fulfillments) ? order.fulfillments : [];
  const successful = fulfillments.find((f) => f.status !== "cancelled" && f.status !== "error");
  if (successful?.created_at) return successful.created_at;
  return order.fulfillment_status === "fulfilled" ? order.updated_at || order.created_at : null;
}

async function upsertImportedOrder(storeId, order) {
  const fields = extractOrderCustomerFields(order);
  await pool.query(
    `INSERT INTO orders (
      shopify_order_id, order_number,
      customer_first_name, customer_last_name, customer_phone, customer_email,
      shipping_address, city, country,
      total_price, financial_status, fulfillment_status,
      order_status, tracking_token, store_id, created_at, fulfilled_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,COALESCE($16::TIMESTAMPTZ, NOW()),$17::TIMESTAMPTZ)
    ON CONFLICT (shopify_order_id) DO UPDATE SET
      order_number = COALESCE(EXCLUDED.order_number, orders.order_number),
      customer_first_name = COALESCE(EXCLUDED.customer_first_name, orders.customer_first_name),
      customer_last_name = COALESCE(EXCLUDED.customer_last_name, orders.customer_last_name),
      customer_phone = COALESCE(EXCLUDED.customer_phone, orders.customer_phone),
      customer_email = COALESCE(EXCLUDED.customer_email, orders.customer_email),
      shipping_address = COALESCE(EXCLUDED.shipping_address, orders.shipping_address),
      city = COALESCE(EXCLUDED.city, orders.city),
      country = COALESCE(EXCLUDED.country, orders.country),
      total_price = COALESCE(EXCLUDED.total_price, orders.total_price),
      financial_status = COALESCE(EXCLUDED.financial_status, orders.financial_status),
      fulfillment_status = COALESCE(EXCLUDED.fulfillment_status, orders.fulfillment_status),
      tracking_token = COALESCE(orders.tracking_token, EXCLUDED.tracking_token),
      fulfilled_at = COALESCE(orders.fulfilled_at, EXCLUDED.fulfilled_at),
      store_id = EXCLUDED.store_id`,
    [
      order.id,
      order.name || String(order.order_number || ""),
      fields.customer_first_name,
      fields.customer_last_name,
      fields.customer_phone,
      fields.customer_email,
      fields.shipping_address,
      fields.city,
      fields.country,
      fields.total_price ?? 0,
      fields.financial_status,
      fields.fulfillment_status,
      mapImportedOrderStatus(order),
      randomUUID(),
      storeId,
      order.created_at || null,
      getFulfilledAt(order),
    ]
  );
}

// Pulls existing orders from Shopify into the local orders table. Runs after
// every (re)install so the dashboard is never empty even if the local rows
// were lost or belong to a previous store record. Existing rows are adopted
// by the current store and keep their dispatcher status and tracking token.
async function importOrdersFromShopify(storeId, { maxPages = 8 } = {}) {
  const store = await getStoreCredentials(storeId);
  if (!store) {
    throw new Error(
      `Store id ${storeId} no longer exists — this dashboard session belongs to an older ` +
      `install. Log out and log in again to reconnect to the current store.`
    );
  }
  if (!store.access_token) {
    throw new Error(
      `Store ${store.shop_domain} has no Shopify access token saved — re-install the app from ` +
      `/auth?shop=${store.shop_domain} to reconnect it.`
    );
  }

  const headers = { "X-Shopify-Access-Token": store.access_token };
  let url = `https://${store.shop_domain}/admin/api/${SHOPIFY_API_VERSION}/orders.json?status=any&limit=250`;
  let imported = 0;
  let seen = 0;
  const failures = [];

  for (let page = 0; page < maxPages && url; page++) {
    const response = await fetch(url, { headers });
    if (!response.ok) {
      const body = (await response.text()).slice(0, 400);
      const message =
        `Shopify GET /orders.json returned ${response.status} for ${store.shop_domain} ` +
        `(saved scope: ${store.scope || "none"}). Response: ${body}`;
      console.error(`[Shopify import] ${message}`);
      // A failure on the very first page means nothing could be imported at
      // all — surface it instead of silently reporting zero.
      if (page === 0) throw new Error(message);
      break;
    }

    const { orders } = await response.json();
    if (!orders || orders.length === 0) break;
    seen += orders.length;

    for (const order of orders) {
      try {
        await upsertImportedOrder(storeId, order);
        imported++;
      } catch (err) {
        failures.push(`${order.name || order.id}: ${err.message}`);
        console.error(`[Shopify import] Order ${order.id} failed:`, err.message);
      }
    }

    const link = response.headers.get("link") || "";
    const nextMatch = link.match(/<([^>]+)>;\s*rel="next"/);
    url = nextMatch ? nextMatch[1] : null;
  }

  if (imported === 0 && failures.length > 0) {
    throw new Error(
      `All ${failures.length} orders failed to save. First error — ${failures[0]}`
    );
  }

  console.log(
    `[Shopify import] Store ${storeId} (${store.shop_domain}): ` +
    `fetched ${seen}, saved ${imported}, failed ${failures.length}`
  );
  return { imported, fetched: seen, failed: failures.length, failures: failures.slice(0, 5) };
}

module.exports = {
  syncOrderTagToShopify,
  markDeliveredInShopify,
  markFulfilledInShopify,
  markUnfulfilledInShopify,
  cancelOrderInShopify,
  deleteOrderInShopify,
  markOrderPaidInShopify,
  fetchOrderCustomerFieldsFromShopify,
  importOrdersFromShopify,
};
