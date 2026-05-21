const crypto = require('crypto');
const router = require('express').Router();

// Shopify sends ?shop=xxx.myshopify.com&hmac=...&timestamp=... when a merchant
// clicks the app. We kick off the OAuth flow so the store gets registered/refreshed.
router.get('/', (req, res) => {
  const shop = (req.query.shop || '').trim().toLowerCase();
  if (shop) {
    return res.redirect(`/auth?shop=${encodeURIComponent(shop)}`);
  }

  // No shop param — verify HMAC and fall back to dashboard
  const { hmac, ...params } = req.query;
  const secret = (process.env.SHOPIFY_CLIENT_SECRET || '').trim();

  if (hmac && secret) {
    const message = Object.keys(params).sort().map(k => `${k}=${params[k]}`).join('&');
    const computed = crypto.createHmac('sha256', secret).update(message).digest('hex');
    try {
      const valid = crypto.timingSafeEqual(Buffer.from(computed, 'hex'), Buffer.from(hmac, 'hex'));
      if (!valid) return res.status(401).send('Invalid launch signature');
    } catch {
      return res.status(401).send('Invalid launch signature');
    }
  }

  res.redirect('/dashboard/login.html');
});

module.exports = router;
