const crypto = require('crypto');
const router = require('express').Router();

router.get('/', (req, res) => {
  const { hmac, ...params } = req.query;
  const secret = (process.env.SHOPIFY_CLIENT_SECRET || '').trim();

  if (!secret) {
    return res.status(500).send('Server misconfigured');
  }

  if (hmac) {
    const message = Object.keys(params)
      .sort()
      .map(k => `${k}=${params[k]}`)
      .join('&');
    const computed = crypto
      .createHmac('sha256', secret)
      .update(message)
      .digest('hex');
    try {
      const valid = crypto.timingSafeEqual(
        Buffer.from(computed, 'hex'),
        Buffer.from(hmac, 'hex')
      );
      if (!valid) return res.status(401).send('Invalid launch signature');
    } catch {
      return res.status(401).send('Invalid launch signature');
    }
  }

  res.redirect('/dashboard/login.html');
});

module.exports = router;
