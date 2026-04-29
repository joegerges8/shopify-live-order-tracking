const crypto = require("crypto");
require("dotenv").config({ quiet: true });

function verifyShopifyWebhook(req, res, next) {
  try {
    const shopifySecret = (process.env.SHOPIFY_CLIENT_SECRET || "").trim();
    const hmacHeader = req.get("X-Shopify-Hmac-Sha256");
    const rawBody = req.body;

    if (!shopifySecret) {
      console.error("[Webhook] Missing SHOPIFY_CLIENT_SECRET env var");
      return res.status(500).send("Server misconfigured");
    }

    if (!hmacHeader) {
      return res.status(401).send("Missing HMAC header");
    }

    if (!rawBody) {
      return res.status(400).send("Missing raw request body");
    }

    const generatedHash = crypto
      .createHmac("sha256", shopifySecret)
      .update(rawBody)
      .digest("base64");

    const generatedBuffer = Buffer.from(generatedHash, "utf8");
    const headerBuffer = Buffer.from(hmacHeader, "utf8");

    if (
      generatedBuffer.length !== headerBuffer.length ||
      !crypto.timingSafeEqual(generatedBuffer, headerBuffer)
    ) {
      return res.status(401).send("Invalid webhook signature");
    }

    next();
  } catch (error) {
    console.error("Webhook verification error:", error);
    return res.status(500).send("Webhook verification failed");
  }
}

module.exports = verifyShopifyWebhook;
