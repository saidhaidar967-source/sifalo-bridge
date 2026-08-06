require('dotenv').config();
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');

const app = express();

const {
  SIFALO_USERNAME,
  SIFALO_API_KEY,
  FB_PIXEL_ID,
  FB_ACCESS_TOKEN,
  BASE_URL,
  CF_ACCOUNT_ID,
  CF_API_TOKEN,
  CF_KV_NAMESPACE_ID,
  R2_ACCESS_KEY_ID,
  R2_SECRET_ACCESS_KEY,
  R2_BUCKET_NAME,
  R2_ENDPOINT,
  PORT = 3000
} = process.env;

// Where the customer lands after their file download starts. This is the
// Systeme.io thank-you page with the upsell offer on it.
const THANK_YOU_URL = 'https://www.raadeeyenets01.co/degso-buuggaaga';

// How long a download link stays valid after payment, in minutes.
const TOKEN_TTL_MINUTES = 10;
const TOKEN_TTL_SECONDS = TOKEN_TTL_MINUTES * 60;

// Add every product you sell here.
const PRODUCTS = {
  book: {
    name: 'Dalbo Buugga',
    price: '4.99',
    downloadUrl: 'https://www.raadeeyenets01.co/degso-buuggaaga'
  },
  guusha: {
    name: 'Guusha Ganacsigaaga',
    price: '3.50',
    downloadUrl: 'https://www.raadeeyenets01.co/degso'
  }
};

// R2 client (S3-compatible).
const r2 = new S3Client({
  region: 'auto',
  endpoint: R2_ENDPOINT,
  credentials: {
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY
  }
});

// Cloudflare KV helpers, called over the REST API since Railway can't use
// native KV bindings.
const KV_BASE = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/storage/kv/namespaces/${CF_KV_NAMESPACE_ID}`;

async function kvPutToken(token, payload, ttlSeconds) {
  await axios.put(
    `${KV_BASE}/values/${encodeURIComponent(token)}?expiration_ttl=${ttlSeconds}`,
    JSON.stringify(payload),
    {
      headers: {
        Authorization: `Bearer ${CF_API_TOKEN}`,
        'Content-Type': 'text/plain'
      }
    }
  );
}

async function kvGetToken(token) {
  try {
    const { data } = await axios.get(
      `${KV_BASE}/values/${encodeURIComponent(token)}`,
      { headers: { Authorization: `Bearer ${CF_API_TOKEN}` } }
    );
    return typeof data === 'string' ? JSON.parse(data) : data;
  } catch (err) {
    if (err.response?.status === 404) return null;
    throw err;
  }
}

// /buy — start Sifalo checkout.
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

// /confirm — verify payment, fire Meta Purchase, issue a temporary download link.
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
      try {
        const userData = {
          client_ip_address: req.ip,
          client_user_agent: req.headers['user-agent']
        };

        if (data.account) {
          const normalizedPhone = String(data.account).replace(/\D/g, '');
          userData.ph = [crypto.createHash('sha256').update(normalizedPhone).digest('hex')];
        }

        await axios.post(
          `https://graph.facebook.com/v19.0/${FB_PIXEL_ID}/events?access_token=${FB_ACCESS_TOKEN}`,
          {
            data: [
              {
                event_name: 'Purchase',
                event_time: Math.floor(Date.now() / 1000),
                event_id: order_id || sid,
                action_source: 'website',
                event_source_url: `${BASE_URL}/confirm`,
                user_data: userData,
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

      const token = crypto.randomBytes(24).toString('hex');

      try {
        await kvPutToken(
          token,
          { product, sid, orderId: order_id || sid, createdAt: Date.now(), usesRemaining: 3 },
          TOKEN_TTL_SECONDS
        );
      } catch (kvErr) {
        console.error('KV token store failed:', kvErr.response?.data || kvErr.message);
        return res.status(500).send('Payment confirmed, but we could not prepare your download. Contact support with reference: ' + sid);
      }

      return res.redirect(`${BASE_URL}/download?token=${token}`);
    }

    res.send('Payment was not completed. If you were charged, contact support and share this reference: ' + sid);
  } catch (err) {
    console.error('Verify failed:', err.response?.data || err.message);
    res.status(500).send('Could not verify your payment. Contact support with reference: ' + sid);
  }
});

// /download — shows a small page that starts the file download automatically,
// then redirects to the thank-you/upsell page a few seconds later.
app.get('/download', async (req, res) => {
  const { token } = req.query;

  if (!token) {
    return res.status(400).send('Missing download link. Please use the link from your payment confirmation.');
  }

  const record = await kvGetToken(token).catch(err => {
    console.error('KV token lookup failed:', err.response?.data || err.message);
    return undefined;
  });

  if (record === undefined) {
    return res.status(500).send('Something went wrong preparing your download. Please try again shortly.');
  }

  if (!record || !(record.usesRemaining > 0)) {
    return res.status(410).send('This download link has expired or is invalid. Contact support with your payment reference if you still need your book.');
  }

  res.setHeader('Content-Type', 'text/html');
  res.send(`
    <!DOCTYPE html>
    <html>
      <head><meta charset="utf-8"><title>Your download is starting</title></head>
      <body>
        <p>Your download is starting. If it does not begin automatically, <a id="dl" href="/download/file?token=${token}">click here</a>.</p>
        <iframe src="/download/file?token=${token}" style="display:none"></iframe>
        <script>
          setTimeout(function () {
            window.location.href = '${THANK_YOU_URL}';
          }, 4000);
        </script>
      </body>
    </html>
  `);
});

// /download/file — validates the token again and streams the PDF straight
// from the private R2 bucket. The real file location is never exposed.
app.get('/download/file', async (req, res) => {
  const { token } = req.query;

  const purposeHeader = (req.headers['purpose'] || req.headers['sec-purpose'] || '').toLowerCase();
  if (purposeHeader.includes('prefetch') || purposeHeader.includes('prerender')) {
    return res.status(204).end();
  }

  if (!token) {
    return res.status(400).send('Missing download link.');
  }

  const record = await kvGetToken(token).catch(err => {
    console.error('KV token lookup failed:', err.response?.data || err.message);
    return undefined;
  });

  if (record === undefined) {
    return res.status(500).send('Something went wrong preparing your download. Please try again shortly.');
  }

  if (!record || !(record.usesRemaining > 0)) {
    return res.status(410).send('This download link has expired or is invalid.');
  }

  const productInfo = PRODUCTS[record.product];
  if (!productInfo) {
    return res.status(404).send('Product not found for this download link.');
  }

  try {
    const command = new GetObjectCommand({
      Bucket: R2_BUCKET_NAME,
      Key: productInfo.r2Key
    });
    const object = await r2.send(command);

    res.setHeader('Content-Type', object.ContentType || 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${productInfo.r2Key}"`);
    if (object.ContentLength) {
      res.setHeader('Content-Length', object.ContentLength);
    }

    object.Body.on('end', () => {
      const remainingTtl = Math.max(
        60,
        Math.floor((record.createdAt + TOKEN_TTL_SECONDS * 1000 - Date.now()) / 1000)
      );
      kvPutToken(
        token,
        { ...record, usesRemaining: record.usesRemaining - 1 },
        remainingTtl
      ).catch(err => console.error('KV token update failed:', err.response?.data || err.message));
    });

    object.Body.pipe(res);
  } catch (err) {
    console.error('R2 stream failed:', err.message);
    res.status(500).send('Could not retrieve your file. Contact support with your payment reference.');
  }
});

app.get('/', (req, res) => res.send('Sifalo Pay bridge is running.'));

app.listen(PORT, () => console.log(`Sifalo bridge running on port ${PORT}`));
