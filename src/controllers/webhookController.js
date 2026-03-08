//Save Shopify orders in DB

const pool = require("../config/db");

async function handleOrderCreated(req, res) {
  try {
    const order = JSON.parse(req.body.toString("utf8"));

    const shopifyOrderId = order.id;
    const orderNumber = order.name || String(order.order_number || "");
    const customerFirstName = order.customer?.first_name || null;
    const customerLastName = order.customer?.last_name || null;

    // Try all common Shopify locations for a customer's phone number.
    // Some stores only store phone on shipping/billing/default address,
    // so we fall back through each of these fields before saving null.
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
        fulfillment_status
      )
      VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12
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
      ]
    );

    return res.status(200).send("Webhook received");
  } catch (error) {
    console.error("Webhook error:", error);
    return res.status(500).send("Server error");
  }
}

module.exports = {
  handleOrderCreated,
};