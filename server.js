require('dotenv').config();
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const app = express();
app.set('trust proxy', 1); // Railway sits behind a proxy
app.use(express.json({ limit: '20kb' }));
app.use(cors());

const {
  SIFALO_USERNAME,
  SIFALO_API_KEY,
  FB_PIXEL_ID,
  FB_ACCESS_TOKEN,
  BASE_URL,
  DATABASE_URL,
  ADMIN_PASSWORD,
  DELIVERED_BASE = '74',   // books already delivered before this system existed
  PORT = 3000
} = process.env;

const DELIVERED_START = parseInt(DELIVERED_BASE, 10) || 0;

// ------------------------------------------------------------------
// Catalogue + delivery rules (the server is the only source of prices)
// ------------------------------------------------------------------
const PRODUCTS = {
  book:   { name: 'Siraha Ganacsi Ee Aan Laguu Sheegin',              price: '4.99' },
  guusha: { name: 'Guusha Ganacsigaaga',                              price: '3.50' },
  billow: { name: 'Sidee Loo Billaabaa Loona Badbaadiyaa Ganacsi?',   price: '4.70' }
};

const REGIONS = {
  benadir:      'Benadir / Mogadishu',
  somaliland:   'Somaliland',
  puntland:     'Puntland',
  southwest:    'Southwest',
  galmudug:     'Galmudug',
  hirshabelle:  'Hirshabelle',
  northeastern: 'Northeastern',
  jubbaland:    'Jubbaland'
};

// Mogadishu: 1 book $1.50, 2+ books $2.00
// Everywhere else: 1 book $4, 2 books $7, 3+ books $10
function deliveryFeeCents(regionId, books) {
  if (regionId === 'benadir') return books <= 1 ? 150 : 200;
  if (books <= 1) return 400;
  if (books === 2) return 700;
  return 1000;
}
const dollars = cents => (cents / 100).toFixed(2);

const GATEWAY_MAP = {
  evc: 'waafi',
  zaad: 'waafi',
  sahal: 'waafi',
  edahab: 'edahab',
  premier: 'pbwallet'
};

// ------------------------------------------------------------------
// Database (Railway Postgres)
// ------------------------------------------------------------------
const pool = DATABASE_URL
  ? new Pool({
      connectionString: DATABASE_URL,
      ssl: /railway\.internal|localhost|127\.0\.0\.1/.test(DATABASE_URL) ? false : { rejectUnauthorized: false }
    })
  : null;

if (pool) {
  // Without this listener, a dropped idle connection crashes the whole server.
  pool.on('error', err => console.error('Database connection error (ignored, pool will reconnect):', err.message));
}

let dbReady = false;
let dbError = DATABASE_URL ? 'starting' : 'DATABASE_URL is not set';

async function initDb() {
  if (!pool) throw new Error('DATABASE_URL is not set');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id              TEXT PRIMARY KEY,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      name            TEXT NOT NULL,
      email           TEXT NOT NULL,
      phone           TEXT NOT NULL,
      method          TEXT NOT NULL,
      region_id       TEXT NOT NULL,
      region          TEXT NOT NULL,
      city            TEXT NOT NULL,
      items           JSONB NOT NULL,
      books           INTEGER NOT NULL,
      books_total     NUMERIC(10,2) NOT NULL,
      delivery_fee    NUMERIC(10,2) NOT NULL,
      total           NUMERIC(10,2) NOT NULL,
      sid             TEXT,
      pay_status      TEXT NOT NULL DEFAULT 'pending',
      pay_message     TEXT,
      paid_at         TIMESTAMPTZ,
      delivery_status TEXT NOT NULL DEFAULT 'new',
      delivered_at    TIMESTAMPTZ,
      fbp             TEXT,
      fbc             TEXT,
      client_ip       TEXT,
      client_ua       TEXT
    )`);
  await pool.query('CREATE INDEX IF NOT EXISTS orders_created_idx ON orders (created_at DESC)');
}

function mapOrder(r) {
  return {
    id: r.id,
    createdAt: r.created_at,
    name: r.name,
    email: r.email,
    phone: r.phone,
    method: r.method,
    region: r.region,
    city: r.city,
    items: r.items,
    books: r.books,
    booksTotal: Number(r.books_total),
    deliveryFee: Number(r.delivery_fee),
    total: Number(r.total),
    sid: r.sid,
    payStatus: r.pay_status,
    payMessage: r.pay_message,
    paidAt: r.paid_at,
    deliveryStatus: r.delivery_status,
    deliveredAt: r.delivered_at
  };
}

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------
const clean = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');

function resolveRegionId(shipping) {
  if (!shipping) return null;
  if (shipping.regionId && REGIONS[shipping.regionId]) return shipping.regionId;
  const label = String(shipping.region || '').trim().toLowerCase();
  return Object.keys(REGIONS).find(id => REGIONS[id].toLowerCase() === label) || null;
}

async function sendMetaPurchase(order, extra = {}) {
  if (!FB_PIXEL_ID || !FB_ACCESS_TOKEN) return;
  try {
    const userData = {
      ph: [sha256(String(order.phone).replace(/\D/g, ''))],
      em: [sha256(String(order.email).trim().toLowerCase())]
    };
    if (order.client_ip) userData.client_ip_address = order.client_ip;
    if (order.client_ua) userData.client_user_agent = order.client_ua;
    if (order.fbp) userData.fbp = order.fbp;
    if (order.fbc) userData.fbc = order.fbc;

    await axios.post(
      `https://graph.facebook.com/v19.0/${FB_PIXEL_ID}/events?access_token=${FB_ACCESS_TOKEN}`,
      {
        data: [{
          event_name: 'Purchase',
          event_time: Math.floor(Date.now() / 1000),
          event_id: order.id,
          action_source: 'website',
          event_source_url: `${BASE_URL}/pay`,
          user_data: userData,
          custom_data: {
            currency: 'USD',
            value: Number(order.total),
            content_type: 'product',
            contents: (order.items || []).map(i => ({ id: i.productId, quantity: i.qty, item_price: i.price })),
            order_id: order.id
          }
        }]
      }
    );
  } catch (err) {
    console.error('Meta CAPI failed:', err.response?.data || err.message);
  }
}

// Marks an order paid exactly once. Returns the row if THIS call changed it
// (so the Meta event fires once), or null if it was already paid.
async function markPaid(orderId, sid) {
  const { rows } = await pool.query(
    `UPDATE orders
        SET pay_status = 'paid', paid_at = now(), sid = COALESCE($2, sid), pay_message = NULL
      WHERE id = $1 AND pay_status <> 'paid'
      RETURNING *`,
    [orderId, sid || null]
  );
  return rows[0] || null;
}

// ------------------------------------------------------------------
// Checkout: /pay (one book) and /pay-cart (several) share one handler
// ------------------------------------------------------------------
async function handleOrder(req, res, rawItems) {
  const b = req.body || {};
  const gateway = GATEWAY_MAP[b.method];
  const name = clean(b.name, 100);
  const email = clean(b.email, 150).toLowerCase();
  const city = clean(b.shipping && b.shipping.city, 100);
  const regionId = resolveRegionId(b.shipping);
  const phone = String(b.phone || '').replace(/\s+/g, '');

  if (!name) return res.status(400).json({ error: 'Enter your name.' });
  if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email.' });
  if (!regionId) return res.status(400).json({ error: 'Choose where you are.' });
  if (!city) return res.status(400).json({ error: 'Enter your city or district.' });
  if (!/^\d{7,15}$/.test(phone)) return res.status(400).json({ error: 'Enter a valid phone number.' });
  if (!gateway) return res.status(400).json({ error: 'Choose a payment method.' });
  if (!Array.isArray(rawItems) || rawItems.length === 0) return res.status(400).json({ error: 'Cart is empty.' });

  // Merge duplicates, validate ids, recompute everything server-side.
  const merged = new Map();
  for (const it of rawItems) {
    const info = PRODUCTS[it && it.productId];
    if (!info) return res.status(400).json({ error: `Unknown product: ${it && it.productId}` });
    const qty = Math.min(99, Math.max(1, parseInt(it.qty, 10) || 1));
    merged.set(it.productId, (merged.get(it.productId) || 0) + qty);
  }
  const items = [];
  let books = 0, booksCents = 0;
  for (const [productId, q] of merged) {
    const qty = Math.min(99, q);
    const priceCents = Math.round(parseFloat(PRODUCTS[productId].price) * 100);
    items.push({ productId, title: PRODUCTS[productId].name, price: priceCents / 100, qty });
    books += qty;
    booksCents += priceCents * qty;
  }
  const feeCents = deliveryFeeCents(regionId, books);
  const totalCents = booksCents + feeCents;

  const orderId = crypto.randomBytes(5).toString('hex').toUpperCase(); // e.g. 3F9A1C7B2E
  const normalizedPhone = phone.replace(/\D/g, '');

  // 1) Save the order BEFORE charging, so nothing is ever lost.
  try {
    await pool.query(
      `INSERT INTO orders
        (id, name, email, phone, method, region_id, region, city, items, books,
         books_total, delivery_fee, total, fbp, fbc, client_ip, client_ua)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
      [orderId, name, email, normalizedPhone, b.method, regionId, REGIONS[regionId], city,
       JSON.stringify(items), books, dollars(booksCents), dollars(feeCents), dollars(totalCents),
       clean(b.fbp, 200) || null, clean(b.fbc, 300) || null, req.ip || null,
       clean(req.headers['user-agent'], 300) || null]
    );
  } catch (err) {
    console.error(`[${orderId}] Could not save order:`, err.message);
    return res.status(503).json({ error: 'Service is temporarily unavailable. Please try again in a moment.' });
  }

  // 2) Charge the full amount: books + delivery.
  console.log(`[${orderId}] Charging $${dollars(totalCents)} (${books} book(s) + $${dollars(feeCents)} delivery to ${REGIONS[regionId]})`);
  let sifaloData;
  try {
    const { data } = await axios.post(
      'https://api.sifalopay.com/gateway/',
      {
        account: normalizedPhone,
        gateway,
        amount: dollars(totalCents),
        currency: 'USD',
        order_id: orderId
      },
      { auth: { username: SIFALO_USERNAME, password: SIFALO_API_KEY }, timeout: 45000 }
    );
    sifaloData = data;
  } catch (err) {
    console.error(`[${orderId}] Sifalo call failed:`, err.response?.data || err.message);
    await pool.query(
      `UPDATE orders SET pay_status='failed', pay_message=$2 WHERE id=$1`,
      [orderId, 'No response from payment provider - check the Sifalo dashboard before assuming it failed']
    ).catch(() => {});
    return res.status(502).json({ error: 'Could not reach payment provider. Please try again.' });
  }

  const { code, sid, response } = sifaloData;

  // 601 — paid
  if (code === '601' || code === 601) {
    const row = await markPaid(orderId, sid).catch(err => {
      console.error(`[${orderId}] markPaid failed:`, err.message);
      return null;
    });
    if (row) await sendMetaPurchase(row);
    return res.json({ status: 'success', orderId, total: totalCents / 100, deliveryFee: feeCents / 100 });
  }

  // 603 — waiting for the customer to approve on their phone
  if (code === '603' || code === 603) {
    await pool.query(`UPDATE orders SET sid=$2, pay_message=$3 WHERE id=$1`, [orderId, sid || null, clean(response, 300)]).catch(() => {});
    return res.json({ status: 'pending', orderId, sid, message: response });
  }

  // anything else — failed / insufficient funds
  await pool.query(`UPDATE orders SET pay_status='failed', sid=$2, pay_message=$3 WHERE id=$1`,
    [orderId, sid || null, clean(response, 300)]).catch(() => {});
  return res.status(402).json({ status: 'failed', code, message: response });
}

app.post('/pay', (req, res) =>
  handleOrder(req, res, [{ productId: (req.body || {}).product, qty: 1 }]).catch(err => {
    console.error('/pay crashed:', err);
    if (!res.headersSent) res.status(500).json({ error: 'Something went wrong. Please try again.' });
  })
);

app.post('/pay-cart', (req, res) =>
  handleOrder(req, res, (req.body || {}).items).catch(err => {
    console.error('/pay-cart crashed:', err);
    if (!res.headersSent) res.status(500).json({ error: 'Something went wrong. Please try again.' });
  })
);

// ------------------------------------------------------------------
// Public: live "books delivered" counter for the storefront
// ------------------------------------------------------------------
app.get('/stats', async (req, res) => {
  res.set('Cache-Control', 'public, max-age=60');
  try {
    const { rows } = await pool.query(
      `SELECT COALESCE(SUM(books),0)::int AS n FROM orders WHERE delivery_status='delivered'`
    );
    res.json({ delivered: DELIVERED_START + rows[0].n });
  } catch (err) {
    console.error('/stats failed:', err.message);
    res.json({ delivered: DELIVERED_START });
  }
});

// ------------------------------------------------------------------
// Admin: password login -> signed token (30 days)
// ------------------------------------------------------------------
const adminKey = () => crypto.createHash('sha256').update('raadeeye-admin:' + ADMIN_PASSWORD).digest();

function signToken() {
  const exp = String(Date.now() + 30 * 24 * 60 * 60 * 1000);
  const sig = crypto.createHmac('sha256', adminKey()).update(exp).digest('hex');
  return `${exp}.${sig}`;
}
function verifyToken(t) {
  if (!ADMIN_PASSWORD || !t) return false;
  const [exp, sig] = String(t).split('.');
  if (!exp || !sig) return false;
  const expected = crypto.createHmac('sha256', adminKey()).update(exp).digest('hex');
  if (sig.length !== expected.length) return false;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false;
  return Number(exp) > Date.now();
}

const loginFails = new Map(); // ip -> { count, resetAt }
app.post('/admin/login', (req, res) => {
  if (!ADMIN_PASSWORD) return res.status(503).json({ error: 'Admin is not set up (ADMIN_PASSWORD missing).' });
  const ip = req.ip || 'x';
  const f = loginFails.get(ip);
  if (f && f.resetAt > Date.now() && f.count >= 8) {
    return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
  }
  const given = crypto.createHash('sha256').update(String((req.body || {}).password || '')).digest();
  const real = crypto.createHash('sha256').update(ADMIN_PASSWORD).digest();
  if (!crypto.timingSafeEqual(given, real)) {
    const cur = f && f.resetAt > Date.now() ? f : { count: 0, resetAt: Date.now() + 15 * 60 * 1000 };
    cur.count++;
    loginFails.set(ip, cur);
    return res.status(401).json({ error: 'Wrong password.' });
  }
  loginFails.delete(ip);
  res.json({ token: signToken() });
});

function requireAdmin(req, res, next) {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  if (!m || !verifyToken(m[1])) return res.status(401).json({ error: 'Please log in.' });
  next();
}

app.get('/admin', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'admin.html'));
});

app.get('/admin/api/orders', requireAdmin, async (req, res) => {
  const filters = {
    todo:      `pay_status='paid' AND delivery_status='new'`,
    pending:   `pay_status <> 'paid'`,
    delivered: `delivery_status='delivered'`,
    all:       `TRUE`
  };
  const where = filters[req.query.filter] || filters.todo;
  try {
    const { rows } = await pool.query(`SELECT * FROM orders WHERE ${where} ORDER BY created_at DESC LIMIT 300`);
    const sum = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE pay_status='paid' AND delivery_status='new')::int AS to_deliver,
        COALESCE(SUM(books) FILTER (WHERE delivery_status='delivered'),0)::int   AS delivered_books,
        COUNT(*) FILTER (WHERE pay_status <> 'paid')::int                        AS unpaid,
        COALESCE(SUM(total) FILTER (WHERE pay_status='paid'),0)::float           AS revenue
      FROM orders`);
    const s = sum.rows[0];
    res.json({
      orders: rows.map(mapOrder),
      summary: {
        toDeliver: s.to_deliver,
        deliveredBooks: s.delivered_books,
        deliveredShown: DELIVERED_START + s.delivered_books,
        unpaid: s.unpaid,
        revenue: s.revenue
      }
    });
  } catch (err) {
    console.error('admin orders failed:', err.message);
    res.status(500).json({ error: 'Could not load orders.' });
  }
});

app.post('/admin/api/orders/:id/delivered', requireAdmin, async (req, res) => {
  const delivered = !!(req.body || {}).delivered;
  try {
    const { rows } = await pool.query(
      `UPDATE orders
          SET delivery_status = $2, delivered_at = CASE WHEN $2 = 'delivered' THEN now() ELSE NULL END
        WHERE id = $1 AND pay_status = 'paid'
        RETURNING *`,
      [req.params.id, delivered ? 'delivered' : 'new']
    );
    if (!rows[0]) return res.status(400).json({ error: 'Order not found or not paid yet.' });
    res.json({ order: mapOrder(rows[0]) });
  } catch (err) {
    console.error('admin delivered failed:', err.message);
    res.status(500).json({ error: 'Could not update order.' });
  }
});

// Ask Sifalo again about an order that was left pending / unclear.
app.post('/admin/api/orders/:id/recheck', requireAdmin, async (req, res) => {
  try {
    const found = await pool.query('SELECT * FROM orders WHERE id=$1', [req.params.id]);
    const order = found.rows[0];
    if (!order) return res.status(404).json({ error: 'Order not found.' });
    if (order.pay_status === 'paid') return res.json({ order: mapOrder(order) });
    if (!order.sid) return res.status(400).json({ error: 'No Sifalo reference for this order - check the Sifalo dashboard.' });

    const { data } = await axios.post(
      'https://api.sifalopay.com/gateway/verify.php',
      { sid: order.sid },
      { auth: { username: SIFALO_USERNAME, password: SIFALO_API_KEY } }
    );

    if (data.status === 'success') {
      const row = await markPaid(order.id, order.sid);
      if (row) await sendMetaPurchase(row);
    } else {
      await pool.query('UPDATE orders SET pay_message=$2 WHERE id=$1', [order.id, clean(data.response || data.status, 300)]);
    }
    const fresh = await pool.query('SELECT * FROM orders WHERE id=$1', [order.id]);
    res.json({ order: mapOrder(fresh.rows[0]) });
  } catch (err) {
    console.error('admin recheck failed:', err.response?.data || err.message);
    res.status(502).json({ error: 'Could not check with Sifalo.' });
  }
});

app.get('/', (req, res) => res.send('Raadeeye Nets order server is running.'));

// Quick check from a phone browser: is the database connected?
app.get('/health', (req, res) => {
  res.json({ server: 'ok', database: dbReady ? 'ok' : 'not connected', detail: dbReady ? null : dbError });
});

async function connectDbWithRetry() {
  for (;;) {
    try {
      await initDb();
      dbReady = true;
      dbError = '';
      console.log('Database ready');
      return;
    } catch (err) {
      dbError = err.message;
      console.error('Database setup failed, retrying in 10s:', err.message);
      await new Promise(r => setTimeout(r, 10000));
    }
  }
}

process.on('unhandledRejection', err => console.error('Unhandled rejection:', err));
process.on('uncaughtException', err => console.error('Uncaught exception:', err));

if (require.main === module) {
  app.listen(PORT, () => console.log(`Order server running on port ${PORT}`));
  if (pool) connectDbWithRetry();
}

module.exports = { app, deliveryFeeCents, resolveRegionId, handleOrder };
