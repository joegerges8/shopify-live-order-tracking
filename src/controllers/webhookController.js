const pool = require("../config/db");
const { randomUUID } = require("crypto");
const { resolveAreaOrUnknown } = require("../utils/areaLookup");

function parseWebhookOrder(req) {
  return JSON.parse(req.body.toString("utf8"));
}

function getNoteAttribute(order, key) {
  const noteAttributes = order.note_attributes || [];
  const normalizedKey = String(key).trim().toLowerCase();
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

function parseNullableNumber(value) {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim();
  if (!trimmed.length) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

function firstNonBlank(...values) {
  for (const value of values) {
    if (value === null || value === undefined) continue;
    const trimmed = String(value).trim();
    if (trimmed.length) return trimmed;
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

function getCustomerName(order) {
  const addresses = getAddressCandidates(order);
  const addressName = splitName(firstNonBlank(...addresses.map((address) => address.name)));
  const noteName = splitName(getAnyNoteAttribute(order, [
    "customer_name",
    "customer name",
    "full_name",
    "full name",
    "name",
  ]));

  return {
    firstName: firstNonBlank(
      order.customer?.first_name,
      ...addresses.map((address) => address.first_name),
      addressName.firstName,
      getAnyNoteAttribute(order, ["first_name", "first name"]),
      noteName.firstName
    ),
    lastName: firstNonBlank(
      order.customer?.last_name,
      ...addresses.map((address) => address.last_name),
      addressName.lastName,
      getAnyNoteAttribute(order, ["last_name", "last name"]),
      noteName.lastName
    ),
  };
}

function getShippingAddress(order) {
  const address = getAddressCandidates(order)[0];
  if (!address) return null;

  return [address.address1, address.address2]
    .filter(Boolean)
    .join(", ") || null;
}

async function getStoreId(shopDomain) {
  if (!shopDomain) return null;
  const result = await pool.query(
    `SELECT id FROM stores WHERE shop_domain = $1 AND active = TRUE LIMIT 1`,
    [shopDomain]
  );
  return result.rows[0]?.id ?? null;
}

async function handleOrderCreated(req, res) {
  try {
    const order = parseWebhookOrder(req);
    const storeId = await getStoreId(req.shopDomain);

    if (!storeId) {
      console.warn(`[Webhook] Ignoring order create for unknown shop: ${req.shopDomain || "missing shop"}`);
      return res.status(200).send("Store not found");
    }

    const shopifyOrderId = order.id;
    const orderNumber = order.name || String(order.order_number || "");
    const customerName = getCustomerName(order);
    const customerFirstName = customerName.firstName;
    const customerLastName = customerName.lastName;
    const addresses = getAddressCandidates(order);

    const customerPhone =
      firstNonBlank(
        order.phone,
        order.customer?.phone,
        ...addresses.map((address) => address.phone)
      );

    const customerEmail = firstNonBlank(order.email, order.customer?.email);

    const shippingAddress = getShippingAddress(order);
    const city = firstNonBlank(
      ...addresses.map((address) => address.city),
      getAnyNoteAttribute(order, ["city", "delivery_city", "delivery city", "shipping_city", "shipping city"])
    );
    const country = firstNonBlank(...addresses.map((address) => address.country));

    // Delivery area (caza) derived from the free-text city. Shopify's province
    // field is null on Lebanese orders, so the city string is the only signal.
    // Falls back to 'Other' rather than null so the dashboard filter and the
    // driver app always have something to group by.
    const area = resolveAreaOrUnknown(city);
    const totalPrice = order.total_price || 0;
    const financialStatus = order.financial_status || null;
    const fulfillmentStatus = order.fulfillment_status || null;

    // The order arriving already paid means the customer paid online, so no
    // cash will change hands on delivery. Captured now because delivering a
    // COD order also sets financial_status to 'paid' — after that the column
    // can no longer tell an online payment from a collected one.
    const prepaid = (financialStatus || "").toLowerCase() === "paid";

    const customerLatitude = parseNullableNumber(getNoteAttribute(order, "latitude"));
    const customerLongitude = parseNullableNumber(getNoteAttribute(order, "longitude"));
    const customerAltitude = parseNullableNumber(getNoteAttribute(order, "altitude"));
    const googleMapsLink =
      getNoteAttribute(order, "google_maps_link") ||
      getNoteAttribute(order, "manual_google_maps_link");

    const trackingToken = randomUUID();

    await pool.query(
      `INSERT INTO orders (
        shopify_order_id, order_number,
        customer_first_name, customer_last_name, customer_phone, customer_email,
        shipping_address, city, area, country,
        total_price, financial_status, fulfillment_status, prepaid,
        customer_latitude, customer_longitude, customer_altitude,
        google_maps_link, tracking_token, store_id, order_status
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
      ON CONFLICT (shopify_order_id) DO UPDATE SET
        order_number = COALESCE(EXCLUDED.order_number, orders.order_number),
        customer_first_name = COALESCE(EXCLUDED.customer_first_name, orders.customer_first_name),
        customer_last_name = COALESCE(EXCLUDED.customer_last_name, orders.customer_last_name),
        customer_phone = COALESCE(EXCLUDED.customer_phone, orders.customer_phone),
        customer_email = COALESCE(EXCLUDED.customer_email, orders.customer_email),
        shipping_address = COALESCE(EXCLUDED.shipping_address, orders.shipping_address),
        city = COALESCE(EXCLUDED.city, orders.city),
        -- Existing area wins: a dispatcher may have corrected it by hand, and a
        -- webhook replay must not undo that.
        area = COALESCE(orders.area, EXCLUDED.area),
        country = COALESCE(EXCLUDED.country, orders.country),
        total_price = COALESCE(EXCLUDED.total_price, orders.total_price),
        financial_status = COALESCE(EXCLUDED.financial_status, orders.financial_status),
        fulfillment_status = COALESCE(EXCLUDED.fulfillment_status, orders.fulfillment_status),
        -- prepaid records how the order arrived, so the stored value always
        -- wins: a webhook replay after delivery carries financial_status
        -- 'paid' for COD orders too and would otherwise rewrite history.
        prepaid = orders.prepaid,
        customer_latitude = COALESCE(EXCLUDED.customer_latitude, orders.customer_latitude),
        customer_longitude = COALESCE(EXCLUDED.customer_longitude, orders.customer_longitude),
        customer_altitude = COALESCE(EXCLUDED.customer_altitude, orders.customer_altitude),
        google_maps_link = COALESCE(EXCLUDED.google_maps_link, orders.google_maps_link),
        order_status = CASE
          WHEN orders.order_status IS NULL OR orders.order_status IN ('CREATED', 'PENDING') THEN EXCLUDED.order_status
          ELSE orders.order_status
        END,
        tracking_token = COALESCE(orders.tracking_token, EXCLUDED.tracking_token),
        store_id = COALESCE(orders.store_id, EXCLUDED.store_id)`,
      [
        shopifyOrderId, orderNumber,
        customerFirstName, customerLastName, customerPhone, customerEmail,
        shippingAddress, city, area, country,
        totalPrice, financialStatus, fulfillmentStatus, prepaid,
        customerLatitude, customerLongitude, customerAltitude,
        googleMapsLink, trackingToken, storeId, "UNFULFILLED",
      ]
    );

    return res.status(200).send("Webhook received");
  } catch (error) {
    console.error("Webhook error:", error);
    return res.status(500).send("Server error");
  }
}

async function handleOrderCancelled(req, res) {
  try {
    const order = parseWebhookOrder(req);
    const storeId = await getStoreId(req.shopDomain);
    const shopifyOrderId = order.id;

    if (!shopifyOrderId) {
      return res.status(200).send("Missing order id");
    }
    if (!storeId) {
      return res.status(200).send("Store not found");
    }

    await pool.query(
      `UPDATE orders
       SET order_status = 'CANCELLED',
           financial_status = COALESCE($2, financial_status),
           fulfillment_status = COALESCE($3, fulfillment_status)
       WHERE shopify_order_id = $1 AND store_id = $4`,
      [shopifyOrderId, order.financial_status || null, order.fulfillment_status || null, storeId]
    );

    return res.status(200).send("Webhook received");
  } catch (error) {
    console.error("Webhook cancel error:", error);
    return res.status(500).send("Server error");
  }
}

async function handleOrderDeleted(req, res) {
  try {
    const order = parseWebhookOrder(req);
    const storeId = await getStoreId(req.shopDomain);
    const shopifyOrderId = order.id;

    if (!shopifyOrderId) {
      return res.status(200).send("Missing order id");
    }
    if (!storeId) {
      return res.status(200).send("Store not found");
    }

    await pool.query(
      `DELETE FROM orders WHERE shopify_order_id = $1 AND store_id = $2`,
      [shopifyOrderId, storeId]
    );

    return res.status(200).send("Webhook received");
  } catch (error) {
    console.error("Webhook delete error:", error);
    return res.status(500).send("Server error");
  }
}

// Fired by Shopify when all items in an order are fulfilled from the Shopify admin.
// Marks the dispatcher order as DELIVERED so both dashboards stay in sync.
async function handleOrderFulfilled(req, res) {
  try {
    const order = parseWebhookOrder(req);
    const storeId = await getStoreId(req.shopDomain);
    const shopifyOrderId = order.id;

    if (!shopifyOrderId) {
      return res.status(200).send("Missing order id");
    }
    if (!storeId) {
      return res.status(200).send("Store not found");
    }

    await pool.query(
      `UPDATE orders
       SET order_status = 'FULFILLED',
           delivered_at = NOW(),
           fulfilled_at = NOW(),
           financial_status = COALESCE($2, financial_status),
           fulfillment_status = COALESCE($3, fulfillment_status)
       WHERE shopify_order_id = $1
         AND store_id = $4
         AND order_status NOT IN ('FULFILLED', 'CANCELLED')`,
      [shopifyOrderId, order.financial_status || null, order.fulfillment_status || null, storeId]
    );

    console.log(`[Webhook] Order ${shopifyOrderId} fulfilled in Shopify → marked DELIVERED`);
    return res.status(200).send("Webhook received");
  } catch (error) {
    console.error("Webhook fulfilled error:", error);
    return res.status(500).send("Server error");
  }
}

async function handleCustomerDataRequest(req, res) {
  try {
    const payload = parseWebhookOrder(req);
    console.log("[Privacy] Customer data request received", {
      shop: req.shopDomain,
      customerId: payload.customer?.id,
      email: payload.customer?.email,
    });

    return res.status(200).send("Webhook received");
  } catch (error) {
    console.error("Customer data request webhook error:", error);
    return res.status(500).send("Server error");
  }
}

async function handleCustomerRedact(req, res) {
  try {
    const payload = parseWebhookOrder(req);
    const storeId = await getStoreId(req.shopDomain);

    if (!storeId) {
      return res.status(200).send("Store not found");
    }

    const email = payload.customer?.email || null;
    const phone = payload.customer?.phone || null;
    const orderIds = Array.isArray(payload.orders_to_redact)
      ? payload.orders_to_redact.filter(Boolean)
      : [];

    await pool.query(
      `UPDATE orders
       SET customer_first_name = NULL,
           customer_last_name = NULL,
           customer_phone = NULL,
           customer_email = NULL,
           shipping_address = NULL,
           customer_latitude = NULL,
           customer_longitude = NULL,
           customer_altitude = NULL,
           google_maps_link = NULL
       WHERE store_id = $1
         AND (
           ($2::TEXT IS NOT NULL AND customer_email = $2)
           OR ($3::TEXT IS NOT NULL AND customer_phone = $3)
           OR (array_length($4::BIGINT[], 1) IS NOT NULL AND shopify_order_id = ANY($4::BIGINT[]))
         )`,
      [storeId, email, phone, orderIds]
    );

    return res.status(200).send("Webhook received");
  } catch (error) {
    console.error("Customer redact webhook error:", error);
    return res.status(500).send("Server error");
  }
}

async function handleShopRedact(req, res) {
  try {
    if (!req.shopDomain) {
      return res.status(200).send("Missing shop domain");
    }

    await pool.query(`DELETE FROM stores WHERE shop_domain = $1`, [req.shopDomain]);
    return res.status(200).send("Webhook received");
  } catch (error) {
    console.error("Shop redact webhook error:", error);
    return res.status(500).send("Server error");
  }
}

module.exports = {
  handleOrderCreated,
  handleOrderCancelled,
  handleOrderDeleted,
  handleOrderFulfilled,
  handleCustomerDataRequest,
  handleCustomerRedact,
  handleShopRedact,
};
