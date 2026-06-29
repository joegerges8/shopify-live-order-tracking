const pool = require("../config/db");
const { randomUUID } = require("crypto");

function parseWebhookOrder(req) {
  return JSON.parse(req.body.toString("utf8"));
}

function getNoteAttribute(order, key) {
  const noteAttributes = order.note_attributes || [];
  const match = noteAttributes.find((item) => item.name === key);
  return match ? match.value : null;
}

function parseNullableNumber(value) {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim();
  if (!trimmed.length) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
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
    console.log("[Webhook Debug] customer:", JSON.stringify(order.customer));
    console.log("[Webhook Debug] shipping_address:", JSON.stringify(order.shipping_address));
    console.log("[Webhook Debug] billing_address:", JSON.stringify(order.billing_address));
    const customerFirstName = order.customer?.first_name || order.shipping_address?.first_name || order.billing_address?.first_name || null;
    const customerLastName = order.customer?.last_name || order.shipping_address?.last_name || order.billing_address?.last_name || null;

    const customerPhone =
      order.phone ||
      order.customer?.phone ||
      order.shipping_address?.phone ||
      order.billing_address?.phone ||
      order.customer?.default_address?.phone ||
      null;

    const customerEmail = order.email || order.customer?.email || null;

    const shippingAddress = order.shipping_address
      ? [order.shipping_address.address1, order.shipping_address.address2]
          .filter(Boolean)
          .join(", ")
      : null;

    const city = order.shipping_address?.city || order.billing_address?.city || null;
    const country = order.shipping_address?.country || order.billing_address?.country || null;
    const totalPrice = order.total_price || 0;
    const financialStatus = order.financial_status || null;
    const fulfillmentStatus = order.fulfillment_status || null;

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
        shipping_address, city, country,
        total_price, financial_status, fulfillment_status,
        customer_latitude, customer_longitude, customer_altitude,
        google_maps_link, tracking_token, store_id
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
      ON CONFLICT (shopify_order_id) DO NOTHING`,
      [
        shopifyOrderId, orderNumber,
        customerFirstName, customerLastName, customerPhone, customerEmail,
        shippingAddress, city, country,
        totalPrice, financialStatus, fulfillmentStatus,
        customerLatitude, customerLongitude, customerAltitude,
        googleMapsLink, trackingToken, storeId,
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
