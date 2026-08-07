// shopifyTokens.js
//
// Shopify stopped accepting non-expiring offline access tokens on the Admin
// API for public apps. Tokens now live 60 minutes and come with a refresh
// token (valid 90 days) that the app exchanges for a new pair without any
// merchant interaction.
//
// This module owns that lifecycle: it migrates a legacy non-expiring token to
// an expiring one the first time it is used, refreshes tokens shortly before
// they lapse, and persists every new pair back to the stores table.

const pool = require("../config/db");

const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;

// Refresh a little before the token actually lapses so work already in flight
// doesn't race the expiry.
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

const TOKEN_EXCHANGE_GRANT = "urn:ietf:params:oauth:grant-type:token-exchange";
const OFFLINE_TOKEN_TYPE = "urn:shopify:params:oauth:token-type:offline-access-token";

// A refresh token is single-use, so two concurrent refreshes for the same store
// would invalidate each other. Callers share one in-flight promise instead.
const inFlight = new Map();

async function loadStore(storeId) {
  const result = await pool.query(
    `SELECT id, shop_domain, access_token, refresh_token, scope,
            token_expires_at, refresh_token_expires_at
     FROM stores WHERE id = $1 LIMIT 1`,
    [storeId]
  );
  return result.rows[0] || null;
}

async function postTokenRequest(shopDomain, params) {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    throw new Error("SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET are not configured");
  }

  const response = await fetch(`https://${shopDomain}/admin/oauth/access_token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      ...params,
    }).toString(),
  });

  const body = await response.text();
  if (!response.ok) {
    const error = new Error(
      `Shopify token endpoint returned ${response.status}: ${body.slice(0, 300)}`
    );
    error.status = response.status;
    throw error;
  }
  return JSON.parse(body);
}

// Writes a fresh token pair. expires_in / refresh_token_expires_in are relative
// seconds, so they're converted to absolute timestamps for storage.
async function saveTokens(storeId, tokens) {
  const expiresAt = tokens.expires_in
    ? new Date(Date.now() + tokens.expires_in * 1000)
    : null;
  const refreshExpiresAt = tokens.refresh_token_expires_in
    ? new Date(Date.now() + tokens.refresh_token_expires_in * 1000)
    : null;

  const result = await pool.query(
    `UPDATE stores
     SET access_token = $1,
         refresh_token = COALESCE($2, refresh_token),
         token_expires_at = $3,
         refresh_token_expires_at = COALESCE($4, refresh_token_expires_at),
         scope = COALESCE($5, scope),
         updated_at = NOW()
     WHERE id = $6
     RETURNING id, shop_domain, access_token, refresh_token, scope,
               token_expires_at, refresh_token_expires_at`,
    [
      tokens.access_token,
      tokens.refresh_token || null,
      expiresAt,
      refreshExpiresAt,
      tokens.scope || null,
      storeId,
    ]
  );
  return result.rows[0];
}

function needsRefresh(store) {
  if (!store.token_expires_at) return false;
  return new Date(store.token_expires_at).getTime() - Date.now() <= REFRESH_MARGIN_MS;
}

// A store saved before expiring tokens existed has an access token but neither
// an expiry nor a refresh token.
function isLegacyToken(store) {
  return Boolean(store.access_token) && !store.refresh_token && !store.token_expires_at;
}

// Trades a legacy non-expiring token for an expiring one. This needs no
// merchant interaction, so stores installed before the change keep working
// without a re-install. The old token is revoked by Shopify on success.
async function migrateLegacyToken(store) {
  console.log(`[Shopify auth] Migrating ${store.shop_domain} to an expiring offline token`);
  const tokens = await postTokenRequest(store.shop_domain, {
    grant_type: TOKEN_EXCHANGE_GRANT,
    subject_token: store.access_token,
    subject_token_type: OFFLINE_TOKEN_TYPE,
    requested_token_type: OFFLINE_TOKEN_TYPE,
    expiring: "1",
  });
  const updated = await saveTokens(store.id, tokens);
  console.log(`[Shopify auth] ${store.shop_domain} now holds an expiring token`);
  return updated;
}

async function refreshExpiringToken(store) {
  if (!store.refresh_token) {
    throw new Error(
      `Store ${store.shop_domain} has no refresh token saved — re-install the app ` +
      `from /auth?shop=${store.shop_domain} to reconnect it.`
    );
  }
  if (
    store.refresh_token_expires_at &&
    new Date(store.refresh_token_expires_at).getTime() <= Date.now()
  ) {
    throw new Error(
      `The Shopify refresh token for ${store.shop_domain} expired (they last 90 days) — ` +
      `re-install the app from /auth?shop=${store.shop_domain} to reconnect it.`
    );
  }

  console.log(`[Shopify auth] Refreshing access token for ${store.shop_domain}`);
  const tokens = await postTokenRequest(store.shop_domain, {
    grant_type: "refresh_token",
    refresh_token: store.refresh_token,
  });
  return saveTokens(store.id, tokens);
}

// Returns the store row carrying a usable access token, migrating or refreshing
// first when required. Returns null when the store or its token is missing.
// Pass { force: true } after a 401 to rotate the token immediately.
async function getStoreAccess(storeId, { force = false } = {}) {
  const store = await loadStore(storeId);
  if (!store || !store.access_token) return store || null;

  const legacy = isLegacyToken(store);
  if (!legacy && !force && !needsRefresh(store)) return store;

  if (inFlight.has(storeId)) return inFlight.get(storeId);

  const work = (async () => {
    try {
      if (legacy) return await migrateLegacyToken(store);
      return await refreshExpiringToken(store);
    } catch (error) {
      if (legacy) {
        // Custom apps and merchant-created apps may still use non-expiring
        // tokens, so a failed migration is not necessarily fatal — keep the
        // existing token and let the API call report the real problem.
        console.warn(
          `[Shopify auth] Could not migrate ${store.shop_domain} to an expiring token: ${error.message}`
        );
        return store;
      }
      throw error;
    } finally {
      inFlight.delete(storeId);
    }
  })();

  inFlight.set(storeId, work);
  return work;
}

module.exports = { getStoreAccess, saveTokens };
