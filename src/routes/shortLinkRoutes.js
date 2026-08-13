const express = require("express");
const router = express.Router();
const { getTrackingDestinationByShopifyOrderId } = require("../services/orderService");

// Customer-facing short tracking link: GET /t/:shopifyOrderId
//
// This exists for WhatsApp templates. Interakt (and tools like it) can only put
// a single variable inside a URL button, and on the "order shipped" event the
// only tracking-related attributes it offers are tracking_url and
// tracking_number — both of which Shopify leaves empty until a fulfilment
// carrying tracking exists. Fulfilling from the Shopify admin creates exactly
// such a fulfilment: no tracking, message already sent, empty link.
//
// shopify_order_id, by contrast, is present on the order from the moment it is
// placed. Pointing the button at /t/<shopify_order_id> means the link is
// correct in every message, whoever fulfils the order and in whatever order the
// webhooks land.
//
// No auth: the resolved token is the credential, exactly as on /track. The id
// is Shopify's own 18-digit order id, which is sparse enough that guessing
// another customer's link is not practical — unlike the sequential order
// number, which anyone could walk.
router.get("/:shopifyOrderId", async (req, res) => {
  const { shopifyOrderId } = req.params;

  // Shopify order ids are positive integers that fit in a BIGINT. Anything else
  // is a broken template variable — an unresolved "{{1}}" or the fallback text
  // configured in the messaging tool — and must not reach the database, where
  // it would raise a type error rather than a clean miss.
  if (!/^\d{1,19}$/.test(shopifyOrderId)) {
    return sendTrackingUnavailable(res, 400);
  }

  try {
    const destination = await getTrackingDestinationByShopifyOrderId(shopifyOrderId);
    if (!destination) return sendTrackingUnavailable(res, 404);

    // 302 rather than 301 throughout: the mapping is stable, but a permanent
    // redirect would be cached by the customer's browser and by WhatsApp's link
    // preview fetcher, leaving no way to retire or re-point a link later. That
    // matters most here — an order can move to an outside carrier after the
    // message carrying this link has already been delivered.
    if (destination.carrierTrackingUrl) {
      // Shipped by Wakilni or the like: hand the customer to the carrier's own
      // tracker rather than a page that knows nothing about their parcel.
      return res.redirect(302, destination.carrierTrackingUrl);
    }

    return res.redirect(302, `/track/track.html?token=${encodeURIComponent(destination.token)}`);
  } catch (error) {
    console.error("Short tracking link error:", error);
    return sendTrackingUnavailable(res, 500);
  }
});

// A customer opened this, not a developer — so no JSON error bodies. Every
// failure looks the same from outside, which also keeps the endpoint from
// confirming whether a given order id exists.
function sendTrackingUnavailable(res, status) {
  res.status(status).type("html").send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <title>Tracking unavailable</title>
      <style>
        body {
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif;
          max-width: 520px;
          margin: 0 auto;
          padding: 64px 24px;
          line-height: 1.6;
          color: #222;
          text-align: center;
        }
        h1 { font-size: 1.3rem; margin-bottom: 8px; }
        p { color: #555; }
      </style>
    </head>
    <body>
      <h1>Tracking is not available for this order</h1>
      <p>The link may have expired, or the order may not be out for delivery yet. Please contact the store if you need an update.</p>
    </body>
    </html>
  `);
}

module.exports = router;
