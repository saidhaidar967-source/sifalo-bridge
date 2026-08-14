require('dotenv').config();
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const cors = require('cors');
const app = express();
app.use(express.json());
app.use(cors());
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
    price: '1',
    r2Key: 'siraha-ganacsi-01.pdf'
  },
  guusha: {
    name: 'Guusha Ganacsigaaga',
    price: '3.50',
    downloadUrl: 'https://www.raadeeyenets01.co/guusha-ganacsi'
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

      if (productInfo.r2Key) {
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

      return res.redirect(productInfo.downloadUrl);
    }

    res.send('Payment was not completed. If you were charged, contact support and share this reference: ' + sid);
  } catch (err) {
    console.error('Verify failed:', err.response?.data || err.message);
    res.status(500).send('Could not verify your payment. Contact support with reference: ' + sid);
  }
});

// /download — shows a small page that starts the file download automatically,
// then redirects to the thank-you/upsell page a few seconds later.
//
// CHANGED: uses a hidden <a download> click instead of a hidden <iframe>.
// On mobile Chrome, an iframe streaming a Content-Disposition: attachment
// response can hijack the whole tab into the native "Download complete"
// screen, which kills the page's JS context before the redirect timer
// fires. A programmatic anchor click with the `download` attribute is
// treated as a background download and doesn't take over the tab.
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
        <script>
          (function () {
            var redirected = false;

            function goToThankYou() {
              if (redirected) return;
              redirected = true;
              window.location.href = '${THANK_YOU_URL}';
            }

            var a = document.createElement('a');
            a.href = '/download/file?token=${token}';
            a.download = '';
            a.style.display = 'none';
            document.body.appendChild(a);
            a.click();

            setTimeout(goToThankYou, 4000);

            document.addEventListener('visibilitychange', function () {
              if (document.visibilityState === 'visible') {
                goToThankYou();
              }
            });
          })();
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
// ============================================================
// DIRECT E-WALLET PAYMENT ROUTE (Doc 1 style — no Sifalo redirect)
// Add this to server.js alongside your existing /buy and /confirm routes.
// Requires: app.use(express.json()) enabled globally or on this route.
// ============================================================

// Map your UI's method labels to Sifalo's gateway values.
const GATEWAY_MAP = {
  evc: 'waafi',
  zaad: 'waafi',
  sahal: 'waafi',
  edahab: 'edahab',
  premier: 'pbwallet'
};

// /pay — charge directly, no redirect to pay.sifalo.com.
// The customer approves via USSD PIN prompt on their own phone; this
// request is expected to hold open until Sifalo has a final result
// (or times out), based on what you've seen with xikmabooks' flow.
// CONFIRM THIS ASSUMPTION IN TESTING — see TESTING.md.
app.post('/pay', async (req, res) => {
  const { product, phone, method } = req.body || {};
  const productInfo = PRODUCTS[product];
  const gateway = GATEWAY_MAP[method];

  if (!productInfo) {
    return res.status(404).json({ error: 'Unknown product.' });
  }
  if (!phone || !/^\d{7,15}$/.test(String(phone).replace(/\s+/g, ''))) {
    return res.status(400).json({ error: 'Enter a valid phone number.' });
  }
  if (!gateway) {
    return res.status(400).json({ error: 'Choose a payment method.' });
  }

  const orderId = crypto.randomBytes(8).toString('hex');
  const normalizedPhone = String(phone).replace(/\D/g, '');

  let sifaloData;
  try {
    const { data } = await axios.post(
      'https://api.sifalopay.com/gateway/',
      {
        account: normalizedPhone,
        gateway,
        amount: productInfo.price,
        currency: 'USD',
        order_id: orderId
      },
      {
        auth: { username: SIFALO_USERNAME, password: SIFALO_API_KEY },
        // USSD approval may take a while — give it room before Axios times out.
        // Tune this once you see real response times in testing.
        timeout: 45000
      }
    );
    sifaloData = data;
  } catch (err) {
    console.error('Direct payment request failed:', err.response?.data || err.message);
    return res.status(502).json({ error: 'Could not reach payment provider. Please try again.' });
  }

  const { code, sid, response } = sifaloData;

  // 601 — success. Do the same post-purchase work /confirm does today:
  // Meta CAPI + R2 token mint, but with data we already have (no verify.php round trip needed).
  if (code === '601' || code === 601) {
    try {
      const userData = {
        client_ip_address: req.ip,
        client_user_agent: req.headers['user-agent'],
        ph: [crypto.createHash('sha256').update(normalizedPhone).digest('hex')]
      };

      await axios.post(
        `https://graph.facebook.com/v19.0/${FB_PIXEL_ID}/events?access_token=${FB_ACCESS_TOKEN}`,
        {
          data: [{
            event_name: 'Purchase',
            event_time: Math.floor(Date.now() / 1000),
            event_id: orderId,
            action_source: 'website',
            event_source_url: `${BASE_URL}/pay`,
            user_data: userData,
            custom_data: {
              currency: 'USD',
              value: parseFloat(productInfo.price),
              content_name: productInfo.name,
              order_id: orderId
            }
          }]
        }
      ).catch(metaErr => console.error('Meta CAPI failed:', metaErr.response?.data || metaErr.message));

      if (productInfo.r2Key) {
        const token = crypto.randomBytes(24).toString('hex');
        await kvPutToken(
          token,
          { product, sid, orderId, createdAt: Date.now(), usesRemaining: 3 },
          TOKEN_TTL_SECONDS
        );
        return res.json({ status: 'success', downloadUrl: `/download?token=${token}` });
      }

      return res.json({ status: 'success', downloadUrl: productInfo.downloadUrl });
    } catch (err) {
      console.error('Post-payment processing failed:', err.response?.data || err.message);
      return res.status(500).json({
        status: 'success_no_download',
        error: 'Payment succeeded but we could not prepare your download. Contact support with reference: ' + sid
      });
    }
  }

  // 603 — pending. Return this as-is; frontend should poll /pay-status?sid=... (below)
  // ONLY if testing shows the initial request returns before final resolution.
  if (code === '603' || code === 603) {
    return res.json({ status: 'pending', sid, message: response });
  }

  // 604 / 600 — insufficient funds / failed.
  return res.status(402).json({ status: 'failed', code, message: response });
});

// /pay-status — polling fallback, only needed if 603 turns out to be common
// and doesn't resolve within the original request. Delete this if testing
// shows /pay already blocks until final status.
app.get('/pay-status', async (req, res) => {
  const { sid, product } = req.query;
  if (!sid) return res.status(400).json({ error: 'Missing sid.' });

  let data;
  try {
    const result = await axios.post(
      'https://api.sifalopay.com/gateway/verify.php',
      { sid },
      { auth: { username: SIFALO_USERNAME, password: SIFALO_API_KEY } }
    );
    data = result.data;
  } catch (err) {
    console.error('Status check failed:', err.response?.data || err.message);
    return res.status(500).json({ error: 'Could not check status.' });
  }

  // Still pending or failed — just relay Sifalo's status, nothing to complete yet.
  if (data.status !== 'success') {
    return res.json({ status: data.status, code: data.code, message: data.response });
  }

  // Resolved to success on a delayed check — do the same completion work
  // /pay does on an immediate 601: Meta Purchase event + R2 download token.
  const productInfo = PRODUCTS[product];
  if (!productInfo) {
    return res.json({ status: 'success_no_download', sid, error: 'Missing product reference for this order.' });
  }

  try {
    const normalizedPhone = data.account ? String(data.account).replace(/\D/g, '') : '';
    const userData = {
      client_ip_address: req.ip,
      client_user_agent: req.headers['user-agent']
    };
    if (normalizedPhone) {
      userData.ph = [crypto.createHash('sha256').update(normalizedPhone).digest('hex')];
    }

    await axios.post(
      `https://graph.facebook.com/v19.0/${FB_PIXEL_ID}/events?access_token=${FB_ACCESS_TOKEN}`,
      {
        data: [{
          event_name: 'Purchase',
          event_time: Math.floor(Date.now() / 1000),
          event_id: sid,
          action_source: 'website',
          event_source_url: `${BASE_URL}/pay-status`,
          user_data: userData,
          custom_data: {
            currency: 'USD',
            value: parseFloat(productInfo.price),
            content_name: productInfo.name,
            order_id: sid
          }
        }]
      }
    ).catch(metaErr => console.error('Meta CAPI failed (pay-status):', metaErr.response?.data || metaErr.message));

    if (productInfo.r2Key) {
      const token = crypto.randomBytes(24).toString('hex');
      await kvPutToken(
        token,
        { product, sid, orderId: sid, createdAt: Date.now(), usesRemaining: 3 },
        TOKEN_TTL_SECONDS
      );
      return res.json({ status: 'success', downloadUrl: `/download?token=${token}` });
    }

    return res.json({ status: 'success', downloadUrl: productInfo.downloadUrl });
  } catch (err) {
    console.error('Post-payment processing failed (pay-status):', err.response?.data || err.message);
    return res.status(500).json({
      status: 'success_no_download',
      error: 'Payment succeeded but we could not prepare your download. Contact support with reference: ' + sid
    });
  }
});
app.get('/', (req, res) => res.send('Sifalo Pay bridge is running.'));

app.listen(PORT, () => console.log(`Sifalo bridge running on port ${PORT}`));
