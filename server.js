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

const PRODUCTS = {
  book: {
    name: 'Dalbo Buugga',
    price: '5.50',
    downloadUrl: 'https://www.raadeeyenets01.co/0ce6826c'
  }
};

app.get('/buy', async (req, res) => {
  const productId = req.query.product;
  const product = PRODUCTS[productId];
  if (!product) {
    return res.status(404).send('Unknown product.');
  }
  const orderId = crypto.randomBytes(8).toString('hex');
  const returnUrl = `${BASE_URL}/confirm?order_id=${orderId}&product=${productId}`;
  console.log('BUY START:', { productId, orderId });
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
  console.log('CONFIRM HIT:', { sid, product, order_id });

  if (!sid) {
    console.log('CONFIRM ERROR: missing sid');
    return res.status(400).send('Missing payment reference. Payment may not have completed.');
  }

  try {
    const { data } = await axios.post(
      'https://api.sifalopay.com/gateway/verify.php',
      { sid },
      { auth: { username: SIFALO_USERNAME, password: SIFALO_API_KEY } }
    );
    console.log('VERIFY RESPONSE:', data);

    if (data.status === 'success' && productInfo) {
      console.log('PAYMENT VERIFIED, sending to Meta...', {
        FB_PIXEL_ID_SET: !!FB_PIXEL_ID,
        FB_ACCESS_TOKEN_SET: !!FB_ACCESS_TOKEN
      });
      try {
        const metaRes = await axios.post(
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
        console.log('META CAPI SUCCESS:', JSON.stringify(metaRes.data));
      } catch (metaErr) {
        console.error('META CAPI FAILED:', metaErr.response?.data || metaErr.message);
      }

      return res.redirect(productInfo.downloadUrl);
    }

    console.log('PAYMENT NOT SUCCESSFUL, status was:', data.status);
    res.send('Payment was not completed. If you were charged, contact support and share this reference: ' + sid);
  } catch (err) {
    console.error('VERIFY FAILED:', err.response?.data || err.message);
    res.status(500).send('Could not verify your payment. Contact support with reference: ' + sid);
  }
});

app.get('/', (req, res) => res.send('Sifalo Pay bridge is running.'));
app.listen(PORT, () => console.log(`Sifalo bridge running on port ${PORT}`));
