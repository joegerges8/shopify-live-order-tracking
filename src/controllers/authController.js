const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const pool = require("../config/db");
const { importOrdersFromShopify } = require("../services/shopifyService");

const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
const APP_URL = (process.env.APP_URL || "https://shopify-live-order-tracking-production.up.railway.app").replace(/\/$/, "");
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || "2026-04";
// Keep in step with [access_scopes] in shopify.app.toml and the Dev Dashboard.
const SCOPES = process.env.SHOPIFY_SCOPES ||
  "read_all_orders,read_orders,write_orders,write_fulfillments," +
  "read_merchant_managed_fulfillment_orders,write_merchant_managed_fulfillment_orders";
const REDIRECT_URI = `${APP_URL}/auth/callback`;

function validateShopDomain(shop) {
  return /^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/.test(shop);
}

function verifyOAuthHmac(query) {
  const { hmac, signature, ...params } = query;
  if (!hmac) return false;
  const message = Object.keys(params).sort().map(k => `${k}=${params[k]}`).join("&");
  const computed = crypto.createHmac("sha256", CLIENT_SECRET).update(message).digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(computed, "hex"), Buffer.from(hmac, "hex"));
  } catch {
    return false;
  }
}

async function startOAuth(req, res) {
  const shop = (req.query.shop || "").trim().toLowerCase();
  if (!shop || !validateShopDomain(shop)) {
    return res.status(400).send("Invalid or missing shop domain");
  }
  const authUrl =
    `https://${shop}/admin/oauth/authorize` +
    `?client_id=${CLIENT_ID}` +
    `&scope=${encodeURIComponent(SCOPES)}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`;
  res.redirect(authUrl);
}

async function oauthCallback(req, res) {
  const { shop, code, hmac } = req.query;

  if (!shop || !validateShopDomain(shop)) {
    return res.status(400).send("Invalid shop domain");
  }
  if (!verifyOAuthHmac(req.query)) {
    return res.status(401).send("HMAC validation failed");
  }
  if (!code) {
    return res.status(400).send("Missing authorization code");
  }

  // Exchange code for an access token. expiring=1 asks for the 60-minute
  // offline token plus a refresh token — Shopify's Admin API no longer accepts
  // the old non-expiring tokens for public apps.
  let access_token, scope, refresh_token, expires_in, refresh_token_expires_in;
  try {
    const tokenRes = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code,
        expiring: "1",
      }).toString(),
    });
    if (!tokenRes.ok) {
      const body = await tokenRes.text();
      throw new Error(`Shopify returned ${tokenRes.status}: ${body.slice(0, 200)}`);
    }
    ({ access_token, scope, refresh_token, expires_in, refresh_token_expires_in } =
      await tokenRes.json());
  } catch (err) {
    console.error("[OAuth] Token exchange failed:", err.message);
    return res.status(500).send("Failed to obtain access token from Shopify");
  }

  const tokenExpiresAt = expires_in ? new Date(Date.now() + expires_in * 1000) : null;
  const refreshTokenExpiresAt = refresh_token_expires_in
    ? new Date(Date.now() + refresh_token_expires_in * 1000)
    : null;

  // Generate one-time setup token
  const setupToken = crypto.randomBytes(32).toString("hex");

  // Fetch store name from Shopify
  let storeName = shop.replace(".myshopify.com", "");
  try {
    const shopInfoRes = await fetch(`https://${shop}/admin/api/${SHOPIFY_API_VERSION}/shop.json`, {
      headers: { "X-Shopify-Access-Token": access_token },
    });
    if (shopInfoRes.ok) {
      const shopData = await shopInfoRes.json();
      storeName = shopData.shop?.name || storeName;
    }
  } catch (_) {}

  // Upsert store record
  const result = await pool.query(
    `INSERT INTO stores (
       shop_domain, access_token, scope, setup_token, store_name,
       refresh_token, token_expires_at, refresh_token_expires_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (shop_domain) DO UPDATE
       SET access_token = EXCLUDED.access_token,
           scope        = EXCLUDED.scope,
           setup_token  = EXCLUDED.setup_token,
           store_name   = EXCLUDED.store_name,
           refresh_token = EXCLUDED.refresh_token,
           token_expires_at = EXCLUDED.token_expires_at,
           refresh_token_expires_at = EXCLUDED.refresh_token_expires_at,
           active       = TRUE
     RETURNING id, admin_password_hash`,
    [
      shop, access_token, scope, setupToken, storeName,
      refresh_token || null, tokenExpiresAt, refreshTokenExpiresAt,
    ]
  );
  const store = result.rows[0];

  // Register webhooks asynchronously (don't block the redirect)
  registerWebhooks(shop, access_token).catch(err =>
    console.error("[OAuth] Webhook registration error:", err.message)
  );

  // Pull existing Shopify orders into the dashboard so it isn't empty after
  // a (re)install — webhooks only cover orders created from now on.
  importOrdersFromShopify(store.id).catch(err =>
    console.error("[OAuth] Order import error:", err.message)
  );

  if (store.admin_password_hash) {
    // Returning install — skip setup, go straight to login
    return res.redirect(`/dashboard/login.html?name=${encodeURIComponent(storeName)}&shop=${encodeURIComponent(shop)}`);
  }
  // First install — send to password setup page
  res.redirect(`/dashboard/setup.html?name=${encodeURIComponent(storeName)}&shop=${encodeURIComponent(shop)}&token=${setupToken}`);
}

async function registerWebhooks(shop, accessToken) {
  const topics = [
    "orders/create",
    // Carries the order note when a merchant writes or edits it on an order
    // that already exists — the usual way a note for the driver is written.
    "orders/updated",
    "orders/cancelled",
    "orders/delete",
    "orders/fulfilled",
    "customers/data_request",
    "customers/redact",
    "shop/redact",
  ];
  for (const topic of topics) {
    const address = `${APP_URL}/webhooks/shopify/${topic}`;
    try {
      const r = await fetch(`https://${shop}/admin/api/${SHOPIFY_API_VERSION}/webhooks.json`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": accessToken,
        },
        body: JSON.stringify({ webhook: { topic, address, format: "json" } }),
      });
      console.log(`[OAuth] Webhook ${topic} → ${r.status}`);
    } catch (err) {
      console.error(`[OAuth] Failed to register ${topic}:`, err.message);
    }
  }
}

async function setupPassword(req, res) {
  const { shop, setup_token, password } = req.body || {};

  if (!shop || !setup_token || !password) {
    return res.status(400).json({ error: "shop, setup_token, and password are required" });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: "Password must be at least 8 characters" });
  }

  const result = await pool.query(
    `SELECT id, setup_token FROM stores WHERE shop_domain = $1 AND active = TRUE LIMIT 1`,
    [shop]
  );
  const store = result.rows[0];

  if (!store || store.setup_token !== setup_token) {
    return res.status(401).json({ error: "Invalid or expired setup token" });
  }

  const hash = await bcrypt.hash(password, 10);
  await pool.query(
    `UPDATE stores SET admin_password_hash = $1, setup_token = NULL WHERE id = $2`,
    [hash, store.id]
  );

  return res.json({ ok: true });
}

module.exports = { startOAuth, oauthCallback, setupPassword };
