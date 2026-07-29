require('dotenv').config();
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const app = express();
const {
  SIFALO_USERNAME,
  SIFALO_API_KEY,
  FB_PIXEL_ID,
  FB_ACCESS_TOKEN,
  BASE_URL,
  PORT = 3000
} = process.env;

// ── Add every product you sell here ──────────────────────────────
const PRODUCTS = {
  book: {
    name: 'Dalbo Buugga',
    price: '4.99',
    downloadUrl: 'https://www.raadeeyenets01.co/0ce6826c'
  }
};
// ──────────────────────────────────────────────────────────────────

app.get('/buy', async (req, res) => {
  const productId = req.query.product;
  const product = PRODUCTS[productId];
  if (!product) {
    return res.status(404).send('Unknown product.');
  }
  const orderId = crypto.randomBytes(8).toString('hex');
  const returnUrl = `${BASE_URL}/confirm?order_id=${orderId}&product=${productId}`;
  try {
    const { data } = await axios.post(
      'https://api.sifalopay.com/gateway/',
      {
        amount: product.price,
        gateway: 'checkout',
        currency: 'USD',
        return_url: returnUrl
      },
      { auth: { username: SIFALO_USERNAME, password: SIFALO_API_KEY } }
    );
    const { key, token } = data;
    res.redirect(
      `https://pay.sifalo.com/checkout/?key=${encodeURIComponent(key)}&token=${encodeURIComponent(token)}`
    );
  } catch (err) {
    console.error('Create payment failed:', err.response?.data || err.message);
    res.status(500).send('Could not start payment. Please try again in a moment.');
  }
});

app.get('/confirm', async (req, res) => {
  const { sid, product, order_id } = req.query;
  const productInfo = PRODUCTS[product];

  if (!sid) {
    return res.status(400).send('Missing payment reference. Payment may not have completed.');
  }

  try {
    const { data } = await axios.post(
      'https://api.sifalopay.com/gateway/verify.php',
      { sid },
      { auth: { username: SIFALO_USERNAME, password: SIFALO_API_KEY } }
    );

    if (data.status === 'success' && productInfo) {
      // Fire Purchase to Meta — exactly once, tied to this specific order
      try {
        await axios.post(
          `https://graph.facebook.com/v19.0/${FB_PIXEL_ID}/events?access_token=${FB_ACCESS_TOKEN}`,
          {
            data: [
              {
                event_name: 'Purchase',
                event_time: Math.floor(Date.now() / 1000),
                event_id: order_id || sid,
                action_source: 'website',
                event_source_url: productInfo.downloadUrl,
                user_data: {
                  client_ip_address: req.ip,
                  client_user_agent: req.headers['user-agent']
                },
                custom_data: {
                  currency: 'USD',
                  value: parseFloat(productInfo.price),
                  content_name: productInfo.name,
                  order_id: order_id || sid
                }
              }
            ]
          }
        );
      } catch (metaErr) {
        console.error('Meta CAPI failed:', metaErr.response?.data || metaErr.message);
      }

      return res.redirect(productInfo.downloadUrl);
    }

    res.send('Payment was not completed. If you were charged, contact support and share this reference: ' + sid);
  } catch (err) {
    console.error('Verify failed:', err.response?.data || err.message);
    res.status(500).send('Could not verify your payment. Contact support with reference: ' + sid);
  }
});

app.get('/', (req, res) => res.send('Sifalo Pay bridge is running.'));
app.listen(PORT, () => console.log(`Sifalo bridge running on port ${PORT}`));
