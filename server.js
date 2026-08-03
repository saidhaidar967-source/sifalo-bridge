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
  DOWNLOAD_PAGE_URL,
  CF_ACCOUNT_ID,
  CF_API_TOKEN,
  CF_KV_NAMESPACE_ID,
  R2_ACCESS_KEY_ID,
  R2_SECRET_ACCESS_KEY,
  R2_ACCOUNT_ID,
  R2_BUCKET_NAME,
  R2_ENDPOINT,
  PORT = 3000
} = process.env;

// ── Add every product you sell here ──────────────────────────────
const PRODUCTS = {
  book: {
    name: 'Dalbo Buugga',
    price: '5.50',
    r2Key: 'siraha-ganacsi-01.pdf' // file inside the private R2 bucket
  }
};
// ──────────────────────────────────────────────────────────────────

// ── R2 client (S3-compatible) ────────────────────────────────────
const r2 = new S3Client({
  region: 'auto',
  endpoint: R2_ENDPOINT,
  credentials: {
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY
  }
});

// ── Cloudflare KV helpers (REST API — Railway can't use native KV bindings) ──
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
    // Cloudflare auto-expires the key after TTL, so if we got data back, it's valid.
    return typeof data === 'string' ? JSON.parse(data) : data;
  } catch (err) {
    if (err.response?.status === 404) return null; // missing or expired
    throw err;
  }
}

// ── /buy — start Sifalo checkout (unchanged) ─────────────────────
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

// ── /confirm — verify payment, fire Meta Purchase, issue a temp download link ──
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
        // Sifalo returns the payer's phone in `account`, already in international
        // format (e.g. 252613687974). Meta requires customer identifiers to be
        // SHA-256 hashed — never send raw phone/email.
        const userData = {
          client_ip_address: req.ip,
          client_user_agent: req.headers['user-agent']
        };

        if (data.account) {
          const normalizedPhone = String(data.account).replace(/\D/g, ''); // digits only
          userData.ph = [
            crypto.createHash('sha256').update(normalizedPhone).digest('hex')
          ];
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

      // Generate a temporary download token, valid 30 minutes, allows a
      // small number of uses (not just 1) — mobile networks drop mid-download
      // often, and browsers sometimes silently prefetch links in the
      // background, so a strict single-use token can lock out a real buyer
      // before they ever see the file. 3 uses is generous for retries but
      // still shuts the link down quickly if it gets forwarded/shared.
      const token = crypto.randomBytes(24).toString('hex');
      const ttlSeconds = 30 * 60;

      try {
        await kvPutToken(
          token,
          { product, sid, orderId: order_id || sid, createdAt: Date.now(), usesRemaining: 3 },
          ttlSeconds
        );
      } catch (kvErr) {
        console.error('KV token store failed:', kvErr.response?.data || kvErr.message);
        return res.status(500).send('Payment confirmed, but we could not prepare your download. Contact support with reference: ' + sid);
      }

      // Send the customer to the Systeme.io "Degso Buuggaaga" thank-you page.
      // Landing on this real page is what lets Meta Pixel fire client-side too
      // (using the SAME event_id as the CAPI call above, so Meta deduplicates
      // and doesn't double-count the sale). The download button on that page
      // should link to BASE_URL + /download?token=... which is handled below.
      if (DOWNLOAD_PAGE_URL) {
        const thankYouUrl = `${DOWNLOAD_PAGE_URL}?token=${token}&order_id=${encodeURIComponent(order_id || sid)}&product=${encodeURIComponent(product)}`;
        return res.redirect(thankYouUrl);
      }

      // Fallback if DOWNLOAD_PAGE_URL isn't configured yet
      return res.redirect(`${BASE_URL}/download?token=${token}`);
    }

    res.send('Payment was not completed. If you were charged, contact support and share this reference: ' + sid);
  } catch (err) {
    console.error('Verify failed:', err.response?.data || err.message);
    res.status(500).send('Could not verify your payment. Contact support with reference: ' + sid);
  }
});

// ── /download — validate token, stream the PDF straight from private R2 ──
app.get('/download', async (req, res) => {
  const { token } = req.query;

  if (!token) {
    return res.status(400).send('Missing download link. Please use the link from your payment confirmation.');
  }

  // Browsers (especially Chrome on Android) sometimes silently pre-fetch
  // links in the background right after a page loads, guessing the user
  // will click them. That request would otherwise burn the token before the
  // real customer ever taps the button. Chrome marks these with a
  // Purpose/Sec-Purpose header — detect and ignore them completely.
  const purposeHeader = (req.headers['purpose'] || req.headers['sec-purpose'] || '').toLowerCase();
  if (purposeHeader.includes('prefetch') || purposeHeader.includes('prerender')) {
    return res.status(204).end();
  }

  let record;
  try {
    record = await kvGetToken(token);
  } catch (err) {
    console.error('KV token lookup failed:', err.response?.data || err.message);
    return res.status(500).send('Something went wrong preparing your download. Please try again shortly.');
  }

  if (!record || !(record.usesRemaining > 0)) {
    return res.status(410).send('This download link has expired or is invalid. Contact support with your payment reference if you still need your book.');
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

    // Only spend one "use" once the download has genuinely finished — if the
    // connection drops partway, this attempt doesn't count against the
    // buyer. After a few completed downloads, the link stops working for
    // everyone — protects against it being shared/forwarded indefinitely.
    object.Body.on('end', () => {
      const remainingTtl = Math.max(
        60,
        Math.floor((record.createdAt + 30 * 60 * 1000 - Date.now()) / 1000)
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
