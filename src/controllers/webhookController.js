//Save Shopify orders in DB

const pool = require("../config/db");

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

async function handleOrderCreated(req, res) {
  try {
    const order = parseWebhookOrder(req);

    const shopifyOrderId = order.id;
    const orderNumber = order.name || String(order.order_number || "");
    const customerFirstName = order.customer?.first_name || null;
    const customerLastName = order.customer?.last_name || null;

    const customerPhone =
      order.phone ||
      order.customer?.phone ||
      order.shipping_address?.phone ||
      order.billing_address?.phone ||
      order.customer?.default_address?.phone ||
      null;

    const customerEmail = order.email || order.customer?.email || null;

    const shippingAddress = order.shipping_address
      ? [
          order.shipping_address.address1,
          order.shipping_address.address2,
        ]
          .filter(Boolean)
          .join(", ")
      : null;

    const city = order.shipping_address?.city || null;
    const country = order.shipping_address?.country || null;
    const totalPrice = order.total_price || 0;
    const financialStatus = order.financial_status || null;
    const fulfillmentStatus = order.fulfillment_status || null;

    const customerLatitude = parseNullableNumber(getNoteAttribute(order, "latitude"));
    const customerLongitude = parseNullableNumber(getNoteAttribute(order, "longitude"));
    const customerAltitude = parseNullableNumber(getNoteAttribute(order, "altitude"));
    const googleMapsLink =
      getNoteAttribute(order, "google_maps_link") ||
      getNoteAttribute(order, "manual_google_maps_link");

    await pool.query(
      `
      INSERT INTO orders (
        shopify_order_id,
        order_number,
        customer_first_name,
        customer_last_name,
        customer_phone,
        customer_email,
        shipping_address,
        city,
        country,
        total_price,
        financial_status,
        fulfillment_status,
        customer_latitude,
        customer_longitude,
        customer_altitude,
        google_maps_link
      )
      VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16
      )
      ON CONFLICT (shopify_order_id) DO NOTHING
      `,
      [
        shopifyOrderId,
        orderNumber,
        customerFirstName,
        customerLastName,
        customerPhone,
        customerEmail,
        shippingAddress,
        city,
        country,
        totalPrice,
        financialStatus,
        fulfillmentStatus,
        customerLatitude,
        customerLongitude,
        customerAltitude,
        googleMapsLink,
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
    const shopifyOrderId = order.id;

    if (!shopifyOrderId) {
      // Return 200 to prevent Shopify retries for invalid payloads.
      return res.status(200).send("Missing order id");
    }

    await pool.query(
      `
      UPDATE orders
      SET
        order_status = 'canceled',
        financial_status = COALESCE($2, financial_status),
        fulfillment_status = COALESCE($3, fulfillment_status)
      WHERE shopify_order_id = $1
      `,
      [
        shopifyOrderId,
        order.financial_status || null,
        order.fulfillment_status || null,
      ]
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
    const shopifyOrderId = order.id;

    if (!shopifyOrderId) {
      // Return 200 to prevent Shopify retries for invalid payloads.
      return res.status(200).send("Missing order id");
    }

    await pool.query(
      `
      DELETE FROM orders
      WHERE shopify_order_id = $1
      `,
      [shopifyOrderId]
    );

    return res.status(200).send("Webhook received");
  } catch (error) {
    console.error("Webhook delete error:", error);
    return res.status(500).send("Server error");
  }
}

module.exports = {
  handleOrderCreated,
  handleOrderCancelled,
  handleOrderDeleted,
};