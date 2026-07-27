require('dotenv').config();
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');

const app = express();

const {
  SIFALO_USERNAME,
  SIFALO_API_KEY,
  BASE_URL,
  PORT = 3000
} = process.env;

// ── Add every product you sell here ──────────────────────────────
// price is in USD (Sifalo only supports USD right now)
// downloadUrl is the exact Systeme.io page the customer lands on after paying
const PRODUCTS = {
  book: {
    name: 'Dalbo Buugga',
    price: '4.99',
    downloadUrl: 'https://www.raadeeyenets01.co/0ce6826c'
  }
  // dalbo: { name: 'Dalbo', price: '9.99', downloadUrl: 'https://...' }
};
// ──────────────────────────────────────────────────────────────────

// Step 1: customer clicks "Buy Now" → this creates the Sifalo payment
// and sends them to the Sifalo checkout page
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

// Step 2: Sifalo sends the customer back here after they pay (or cancel)
// We verify the transaction, then send them to the real download page
app.get('/confirm', async (req, res) => {
  const { sid, product } = req.query;
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
