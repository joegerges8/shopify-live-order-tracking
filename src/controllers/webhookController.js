const pool = require("../config/db");
const { randomUUID } = require("crypto");
const { resolveAreaOrUnknown } = require("../utils/areaLookup");
const {
  syncOrderTagToShopify,
  markFulfilledInShopify,
  findCarrierTracking,
} = require("../services/shopifyService");
const { extractLineItems } = require("../utils/lineItems");
const { extractOrderNote } = require("../utils/orderNote");

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

    // The products in the order, kept so the driver app can show what is in
    // the bag without a Shopify call of its own.
    const lineItems = extractLineItems(order);

    // The order note, shown to the driver on the order detail screen. Most
    // notes are written in the Shopify admin after the order lands, which the
    // orders/updated webhook picks up; this only catches the ones already
    // there at checkout.
    const note = extractOrderNote(order);

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
        google_maps_link, tracking_token, store_id, order_status, line_items, note
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22::JSONB,$23)
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
        -- A replay whose payload carries no usable line items must not erase
        -- the ones already stored.
        line_items = CASE
          WHEN jsonb_array_length(EXCLUDED.line_items) > 0 THEN EXCLUDED.line_items
          ELSE orders.line_items
        END,
        -- A create replay carrying no note must not wipe one written in the
        -- Shopify admin since; clearing a note is the updated webhook's job.
        note = COALESCE(EXCLUDED.note, orders.note),
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
        JSON.stringify(lineItems), note,
      ]
    );

    return res.status(200).send("Webhook received");
  } catch (error) {
    console.error("Webhook error:", error);
    return res.status(500).send("Server error");
  }
}

// orders/updated fires on every edit to an order, which is how a note written
// in the Shopify admin after the order was placed reaches the driver — the
// normal case, since the merchant reads the order first and then writes the
// instructions for the driver.
//
// The handler deliberately touches nothing but the note. This topic also fires
// for the app's own writes (delivery tags, fulfilment, marking COD orders
// paid), and the payload of those echoes would otherwise fight the dispatcher's
// state: a driver's status, a corrected area or the prepaid flag would be
// rewritten from a stale Shopify snapshot. Orders unknown to the database are
// ignored rather than inserted — orders/create owns that.
async function handleOrderUpdated(req, res) {
  try {
    const order = parseWebhookOrder(req);
    const storeId = await getStoreId(req.shopDomain);
    const shopifyOrderId = order.id;

    if (!shopifyOrderId) {
      return res.status(200).send("Missing order id");
    }
    if (!storeId) {
      console.warn(`[Webhook] Ignoring order update for unknown shop: ${req.shopDomain || "missing shop"}`);
      return res.status(200).send("Store not found");
    }

    // Written straight through, null included: the merchant deleting a note in
    // Shopify has to remove it from the driver's screen too, so this is the
    // one path that clears the column.
    await pool.query(
      `UPDATE orders SET note = $1 WHERE shopify_order_id = $2 AND store_id = $3`,
      [extractOrderNote(order), shopifyOrderId, storeId]
    );

    return res.status(200).send("Webhook received");
  } catch (error) {
    console.error("Order updated webhook error:", error);
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
//
// Fulfilling in the Shopify admin is the moment the parcel leaves the counter,
// so it moves the dispatcher order straight to PICKED_UP — the dispatcher does
// not have to repeat the same step in the dashboard afterwards.
//
// delivered_at is deliberately left alone: the parcel is with the driver, not
// with the customer. That timestamp belongs to the driver or dispatcher marking
// the order DELIVERED, and is what performanceService counts as a completed
// delivery.
//
// Orders already further along are not dragged backwards — an order out for
// delivery or delivered stays where it is. Assigning a driver afterwards does
// not regress the status either; see assignDriverToOrder.
//
// None of that applies to an order shipped by an outside carrier. Wakilni and
// the like write their own tracking link onto the fulfilment as they create it,
// which is how such an order is recognised: it is not ours to deliver, so it is
// left at FULFILLED, out of the driver flow and out of the delivery figures,
// and the carrier's link is stored for /t/<id> to forward the customer to.
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

    const carrier = findCarrierTracking(order);

    // The payment fields are refreshed whatever state the order is in, while
    // the status only moves forward — hence the CTE, which keeps the previous
    // status so the code below can tell an order it just advanced from one that
    // was already on its way.
    //
    // fulfilled_at is set once and then left: Shopify retries a webhook it did
    // not get a 200 for, and re-stamping it would push the order's disappearance
    // from the dashboard further out each time.
    const result = await pool.query(
      `WITH prev AS (
         SELECT id, order_status
         FROM orders
         WHERE shopify_order_id = $1 AND store_id = $4
       )
       UPDATE orders o
       SET order_status = CASE
             WHEN prev.order_status IN ('PICKED_UP', 'OUT_FOR_DELIVERY', 'DELIVERED', 'CANCELLED')
               THEN o.order_status
             WHEN $5::text IS NOT NULL THEN 'FULFILLED'
             ELSE 'PICKED_UP'
           END,
           -- An order one of our drivers is already carrying stays ours: a
           -- carrier link arriving afterwards must not redirect the customer
           -- away from the driver actually holding their parcel.
           carrier_tracking_url = CASE
             WHEN prev.order_status IN ('PICKED_UP', 'OUT_FOR_DELIVERY', 'DELIVERED')
               THEN o.carrier_tracking_url
             ELSE COALESCE($5, o.carrier_tracking_url)
           END,
           carrier_name = CASE
             WHEN prev.order_status IN ('PICKED_UP', 'OUT_FOR_DELIVERY', 'DELIVERED')
               THEN o.carrier_name
             ELSE COALESCE($6, o.carrier_name)
           END,
           fulfilled_at = COALESCE(o.fulfilled_at, NOW()),
           financial_status = COALESCE($2, o.financial_status),
           fulfillment_status = COALESCE($3, o.fulfillment_status)
       FROM prev
       WHERE o.id = prev.id
       RETURNING o.*, prev.order_status AS previous_status`,
      [
        shopifyOrderId,
        order.financial_status || null,
        order.fulfillment_status || null,
        storeId,
        carrier?.url || null,
        carrier?.company || null,
      ]
    );

    const row = result.rows[0];
    if (!row) {
      console.log(`[Webhook] Order ${shopifyOrderId} fulfilled in Shopify — not found for this store`);
      return res.status(200).send("Webhook received");
    }
    if (row.previous_status === row.order_status) {
      // Already picked up or beyond, or cancelled — nothing advanced, so the
      // tracking link and tag are already in place from the first time round.
      console.log(`[Webhook] Order ${shopifyOrderId} fulfilled in Shopify — already ${row.order_status}`);
      return res.status(200).send("Webhook received");
    }

    // Someone else's delivery. Nothing to attach — the carrier's link is
    // already on the fulfilment and now stored here too — and nothing to tag,
    // since the order never enters the driver flow.
    if (carrier) {
      console.log(
        `[Webhook] Order ${shopifyOrderId} fulfilled by ${carrier.company || "an outside carrier"} — left out of the driver flow`
      );
      return res.status(200).send("Webhook received");
    }

    // What clicking "Picked Up" in the dashboard used to do. Fulfilling from
    // the Shopify admin creates a fulfilment carrying no tracking, so without
    // this the order would never get its tracking link — the dispatcher's click
    // was the only thing attaching it. Both calls are fire-and-forget: Shopify
    // being slow or down must not fail the webhook, which Shopify would then
    // retry and re-apply.
    markFulfilledInShopify(storeId, row.shopify_order_id, row).catch(err =>
      console.error("[Shopify sync] attach tracking on fulfil failed:", err.message)
    );
    syncOrderTagToShopify(storeId, row.shopify_order_id, "PICKED_UP").catch(err =>
      console.error("[Shopify sync] picked up tag failed:", err.message)
    );

    console.log(`[Webhook] Order ${shopifyOrderId} fulfilled in Shopify — marked picked up`);
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
  handleOrderUpdated,
  handleOrderCancelled,
  handleOrderDeleted,
  handleOrderFulfilled,
  handleCustomerDataRequest,
  handleCustomerRedact,
  handleShopRedact,
};
