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
const jsonSmall = express.json({ limit: '20kb' });
const jsonLarge = express.json({ limit: '16mb' });   // admin uploads (cover images, sample PDFs)
app.use((req, res, next) => (req.path.startsWith('/admin/api/') ? jsonLarge : jsonSmall)(req, res, next));
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
  book:   { name: 'Siraha Ganacsi Ee Aan Laguu Sheegin',              price: '9.50' },
  guusha: { name: 'Guusha Ganacsigaaga',                              price: '6.70' },
  billow: { name: 'Sidee Loo Billaabaa Loona Badbaadiyaa Ganacsi?',   price: '9.00' },
  shayddaanka: { name: 'Shayddaanka & Aadanaha',                       price: '7.90' },
  jacaylka:    { name: 'Jacaylka Alle',                                price: '6.50' },
  raadka:      { name: 'Raadkii Rasuulka',                             price: '9.50' },
  lajirka:     { name: 'La Jirka Suubbanaha',                          price: '9.00' },
  abaallaawe:  { name: 'Abaallaawe',                                   price: '8.50' },
  xalaasha:    { name: 'Xalaasha Ayaa Inoo Ballan Ah',                 price: '10.00' }
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

// Delivery fees. The numbers below are only the defaults: once you save "Delivery fees"
// in the admin page, the saved values are used instead (for the store AND for charging).
// localRegions = the regions where you keep stock: customers there get the fast, cheaper "local" rates (benadir1/benadir2).
let deliveryCfg = { benadir1: 1.5, benadir2: 2, other1: 2, other2: 3, other3: 5, localRegions: ['benadir', 'somaliland'] };
function deliveryFeeCents(regionId, books) {
  const d = deliveryCfg;
  const usd = (d.localRegions || []).includes(regionId)
    ? (books <= 1 ? d.benadir1 : d.benadir2)
    : (books <= 1 ? d.other1 : books === 2 ? d.other2 : d.other3);
  return Math.round(usd * 100);
}
const dollars = cents => (cents / 100).toFixed(2);

// Catalogue kept in memory, loaded from the database (books, page texts, delivery fees).
// While the database has no books (or is down) the built-in PRODUCTS list above is used instead.
let catalog = { books: [], texts: null, delivery: null, loadedAt: 0 };
function getProduct(id) {
  if (catalog.books.length) {
    const b = catalog.books.find(x => x.id === id);
    return b ? { name: b.title, price: Number(b.price).toFixed(2) } : null;
  }
  return Object.prototype.hasOwnProperty.call(PRODUCTS, id) ? PRODUCTS[id] : null;
}

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

// Safe summary of where DATABASE_URL points (host and port only, never the password).
function dbTarget() {
  if (!DATABASE_URL) return { error: 'DATABASE_URL is not set' };
  try {
    const u = new URL(DATABASE_URL);
    if (!u.hostname) return { error: 'DATABASE_URL has no host name after the @ - paste the FULL address from Railway' };
    return { host: u.hostname, port: u.port || '5432' };
  } catch (e) {
    return { error: 'DATABASE_URL is not a valid address - it should start with postgresql:// and contain @host:port/database' };
  }
}

let dbReady = false;
let dbError = DATABASE_URL ? 'starting' : 'DATABASE_URL is not set';

async function initDb() {
  if (!pool) throw new Error('DATABASE_URL is not set');
  const t = dbTarget();
  if (t.error) throw new Error(t.error);
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
  await pool.query('ALTER TABLE orders ADD COLUMN IF NOT EXISTS notes TEXT');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS books (
      id          TEXT PRIMARY KEY,
      title       TEXT NOT NULL,
      author      TEXT NOT NULL DEFAULT '',
      meta        TEXT NOT NULL DEFAULT '',
      category    TEXT NOT NULL DEFAULT 'Books',
      price       NUMERIC(10,2) NOT NULL,
      rating      NUMERIC(2,1),
      visible     BOOLEAN NOT NULL DEFAULT TRUE,
      position    INTEGER NOT NULL DEFAULT 0,
      info        JSONB NOT NULL DEFAULT '[]',
      cover       BYTEA,
      cover_mime  TEXT,
      cover_v     INTEGER NOT NULL DEFAULT 1,
      sample      BYTEA,
      sample_name TEXT,
      sample_v    INTEGER NOT NULL DEFAULT 1,
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  await pool.query('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())');
  await pool.query('ALTER TABLE books ADD COLUMN IF NOT EXISTS rating NUMERIC(2,1)');
  await seedIfEmpty();
  await pool.query('UPDATE books SET rating = 4.5 WHERE rating IS NULL');   // books without a rating yet
  // one time: move the three old category names to the new category list
  const migrated = await pool.query("SELECT 1 FROM settings WHERE key = 'migrated_categories_v1'");
  if (!migrated.rowCount) {
    await pool.query("UPDATE books SET category = 'Business & Money' WHERE category = 'Business'");
    await pool.query("UPDATE books SET category = 'Religion & Spirituality' WHERE category = 'Nonfiction'");
    await pool.query("UPDATE books SET category = 'Fiction & Novels' WHERE category = 'Fiction'");
    await pool.query("INSERT INTO settings (key, value) VALUES ('migrated_categories_v1', 'true') ON CONFLICT (key) DO NOTHING");
  }
  await refreshCatalog();
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
    deliveredAt: r.delivered_at,
    notes: r.notes || ''
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
// Catalogue: books, page texts, delivery fees (edited in the admin page)
// ------------------------------------------------------------------
function parseDataUrl(u, allowed) {
  const m = /^data:([a-z]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(String(u || ''));
  if (!m || !allowed.includes(m[1].toLowerCase())) return null;
  return { mime: m[1].toLowerCase(), buf: Buffer.from(m[2].replace(/\s+/g, ''), 'base64') };
}

// First start only: copy the starter content (seed.json, next to this file) into the database.
async function seedIfEmpty() {
  let seed = null;
  try { seed = JSON.parse(fs.readFileSync(path.join(__dirname, 'seed.json'), 'utf8')); }
  catch (e) { console.log('No seed.json found - starting with an empty catalogue (the store keeps its built-in books).'); return; }

  const n = (await pool.query('SELECT COUNT(*)::int AS n FROM books')).rows[0].n;
  if (n === 0 && Array.isArray(seed.books)) {
    for (const b of seed.books) {
      const cover = parseDataUrl(b.cover, ['image/jpeg', 'image/png', 'image/webp']);
      await pool.query(
        `INSERT INTO books (id, title, author, meta, category, price, visible, position, info, cover, cover_mime, rating)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (id) DO NOTHING`,
        [b.id, b.title, b.author || '', b.meta || '', b.category || 'Books', b.price, b.visible !== false,
         b.position || 0, JSON.stringify(b.info || []), cover ? cover.buf : null, cover ? cover.mime : null, b.rating || null]);
    }
    console.log(`Seeded ${seed.books.length} books`);
  }
  // databases created before ratings existed: give the starter books their starter rating (only where none is set)
  if (n > 0 && Array.isArray(seed.books)) {
    for (const b of seed.books) if (b.rating) await pool.query('UPDATE books SET rating=$2 WHERE id=$1 AND rating IS NULL', [b.id, b.rating]);
  }
  for (const key of ['texts', 'delivery']) {
    if (seed[key]) {
      await pool.query('INSERT INTO settings (key, value) VALUES ($1,$2) ON CONFLICT (key) DO NOTHING', [key, JSON.stringify(seed[key])]);
    }
  }
}

function bookRowToPublic(r) {
  return {
    id: r.id, title: r.title, author: r.author, meta: r.meta, category: r.category,
    price: Number(r.price), rating: r.rating == null ? null : Number(r.rating), info: r.info || [],
    cover: r.cover_mime ? `/books/${encodeURIComponent(r.id)}/cover?v=${r.cover_v}` : null,
    sample: r.sample_name ? `/books/${encodeURIComponent(r.id)}/sample?v=${r.sample_v}` : null
  };
}

async function refreshCatalog() {
  if (!pool) return;
  const books = await pool.query(
    `SELECT id,title,author,meta,category,price,rating,info,cover_mime,cover_v,sample_name,sample_v
       FROM books WHERE visible ORDER BY position, title`);
  const st = await pool.query('SELECT key, value FROM settings');
  const settings = Object.fromEntries(st.rows.map(r => [r.key, r.value]));
  if (settings.delivery) deliveryCfg = { ...deliveryCfg, ...cleanDelivery(settings.delivery, deliveryCfg) };
  catalog = { books: books.rows.map(bookRowToPublic), texts: settings.texts || null, delivery: settings.delivery || null, loadedAt: Date.now() };
}

const money2 = v => { const x = Number(v); return Number.isFinite(x) && x >= 0 && x <= 1000 ? Math.round(x * 100) / 100 : null; };
function cleanDelivery(d, base) {
  const out = {};
  for (const k of ['benadir1', 'benadir2', 'other1', 'other2', 'other3']) {
    const v = money2(d && d[k]);
    out[k] = v == null ? base[k] : v;
  }
  out.localRegions = Array.isArray(d && d.localRegions) ? [...new Set(d.localRegions.map(String))].filter(id => Object.prototype.hasOwnProperty.call(REGIONS, id)) : (base.localRegions || []);
  out.timeMog = clean(d && d.timeMog, 60) || 'within 24 hours';
  out.timeOther = clean(d && d.timeOther, 60) || '2 to 3 days';
  return out;
}

// Page texts: only known keys, strings are trimmed and length-limited, lists are size-limited.
const TEXT_STRINGS = ['heroTag', 'heroTitle', 'heroText', 'shelfSub', 'introSub', 'testiSub', 'pqText', 'pqAuthor',
  'guaranteeHeadline', 'guaranteeButton', 'faqSub', 'ctaEyebrow', 'ctaHeading', 'ctaSub', 'ctaButton', 'whatsapp', 'whatsappDisplay'];
function cleanTexts(t) {
  const out = {};
  t = t || {};
  for (const k of TEXT_STRINGS) if (typeof t[k] === 'string') out[k] = clean(t[k], 1500);
  if (out.whatsapp != null) out.whatsapp = out.whatsapp.replace(/\D/g, '').slice(0, 20);
  const list = (v, max, fn) => (Array.isArray(v) ? v.slice(0, max).map(fn).filter(Boolean) : undefined);
  const put = (k, v) => { if (v !== undefined) out[k] = v; };
  put('introParas', list(t.introParas, 30, p => clean(p, 3000) || null));
  put('guaranteeBullets', list(t.guaranteeBullets, 12, p => clean(p, 1000) || null));
  put('messages', list(t.messages, 40, p => clean(p, 500) || null));
  put('testimonials', list(t.testimonials, 30, p => (p && clean(p.text, 1500)) ? { text: clean(p.text, 1500), name: clean(p.name, 200) } : null));
  put('faqs', list(t.faqs, 40, p => (p && clean(p.q, 300)) ? { q: clean(p.q, 300), a: String(p.a || '').trim().slice(0, 5000) } : null));
  return out;
}

const slugify = s => String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'book';

app.get('/catalog', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({
    books: catalog.books,
    texts: catalog.texts,
    delivery: catalog.delivery ? { ...deliveryCfg, timeMog: catalog.delivery.timeMog, timeOther: catalog.delivery.timeOther } : null
  });
});

app.get('/books/:id/cover', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT cover, cover_mime FROM books WHERE id=$1', [req.params.id]);
    if (!rows[0] || !rows[0].cover) return res.status(404).end();
    res.set('Content-Type', rows[0].cover_mime);
    res.set('Cache-Control', 'public, max-age=31536000, immutable');   // the ?v=N in the URL changes when the cover changes
    res.send(rows[0].cover);
  } catch (e) { res.status(500).end(); }
});

app.get('/books/:id/sample', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT sample, sample_name FROM books WHERE id=$1 AND visible', [req.params.id]);
    if (!rows[0] || !rows[0].sample) return res.status(404).end();
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', `attachment; filename="${slugify(rows[0].sample_name || req.params.id)}.pdf"`);
    res.set('Cache-Control', 'public, max-age=300');
    res.send(rows[0].sample);
  } catch (e) { res.status(500).end(); }
});

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
  const infos = new Map();
  for (const it of rawItems) {
    const info = getProduct(it && it.productId);
    if (!info) return res.status(400).json({ error: `Unknown product: ${it && it.productId}` });
    infos.set(it.productId, info);
    const qty = Math.min(99, Math.max(1, parseInt(it.qty, 10) || 1));
    merged.set(it.productId, (merged.get(it.productId) || 0) + qty);
  }
  const items = [];
  let books = 0, booksCents = 0;
  for (const [productId, q] of merged) {
    const qty = Math.min(99, q);
    const priceCents = Math.round(parseFloat(infos.get(productId).price) * 100);
    items.push({ productId, title: infos.get(productId).name, price: priceCents / 100, qty });
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

// ---- Admin: books -------------------------------------------------
const bookRowToAdmin = r => ({
  id: r.id, title: r.title, author: r.author, meta: r.meta, category: r.category, price: Number(r.price), rating: r.rating == null ? 4.5 : Number(r.rating),
  visible: r.visible, position: r.position, info: r.info || [],
  hasCover: !!r.cover_mime, coverUrl: r.cover_mime ? `/books/${encodeURIComponent(r.id)}/cover?v=${r.cover_v}` : null,
  hasSample: !!r.sample_name, sampleName: r.sample_name, sampleUrl: r.sample_name ? `/books/${encodeURIComponent(r.id)}/sample?v=${r.sample_v}` : null
});
const BOOK_COLS = 'id,title,author,meta,category,price,rating,visible,position,info,cover_mime,cover_v,sample_name,sample_v';

app.get('/admin/api/books', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT ${BOOK_COLS} FROM books ORDER BY position, title`);
    res.json({ books: rows.map(bookRowToAdmin) });
  } catch (err) { console.error('admin books failed:', err.message); res.status(500).json({ error: 'Could not load books.' }); }
});

function readBookBody(b, res, isNew) {
  const title = clean(b.title, 200);
  const price = money2(b.price);
  if (!title) { res.status(400).json({ error: 'Enter the book title.' }); return null; }
  if (price == null || price <= 0) { res.status(400).json({ error: 'Enter a price above 0 (for example 9.50).' }); return null; }
  const rating = Math.round(Number(b.rating) * 10) / 10;
  if (!(rating >= 4 && rating <= 5)) { res.status(400).json({ error: 'The rating must be between 4.0 and 5.0 (for example 4.6).' }); return null; }
  const out = {
    title, price, rating,
    author: clean(b.author, 200), meta: clean(b.meta, 200), category: clean(b.category, 60) || 'Books',
    visible: b.visible !== false,
    info: (Array.isArray(b.info) ? b.info : []).slice(0, 20).map(p => String(p || '').trim().slice(0, 6000)).filter(Boolean)
  };
  if (b.cover) {
    const c = parseDataUrl(b.cover, ['image/jpeg', 'image/png', 'image/webp']);
    if (!c || c.buf.length > 3 * 1024 * 1024) { res.status(400).json({ error: 'The cover must be a JPG, PNG or WebP image under 3 MB.' }); return null; }
    out.cover = c;
  }
  if (b.sample) {
    const p = parseDataUrl(b.sample, ['application/pdf']);
    if (!p || p.buf.length > 10 * 1024 * 1024 || p.buf.slice(0, 4).toString() !== '%PDF') { res.status(400).json({ error: 'The sample must be a PDF under 10 MB.' }); return null; }
    out.sample = p.buf; out.sampleName = clean(b.sampleName, 150) || title;
  }
  out.removeSample = !!b.removeSample;
  return out;
}

app.post('/admin/api/books', requireAdmin, async (req, res) => {
  try {
    const b = readBookBody(req.body || {}, res, true);
    if (!b) return;
    let id = slugify((req.body || {}).id || b.title);
    const taken = new Set((await pool.query('SELECT id FROM books')).rows.map(r => r.id));
    let base = id, i = 2; while (taken.has(id)) id = `${base}-${i++}`;
    const pos = (await pool.query('SELECT COALESCE(MAX(position),-1)+1 AS p FROM books')).rows[0].p;
    await pool.query(
      `INSERT INTO books (id,title,author,meta,category,price,visible,position,info,cover,cover_mime,sample,sample_name,rating)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [id, b.title, b.author, b.meta, b.category, b.price, b.visible, pos, JSON.stringify(b.info),
       b.cover ? b.cover.buf : null, b.cover ? b.cover.mime : null, b.sample || null, b.sample ? b.sampleName : null, b.rating]);
    await refreshCatalog();
    res.json({ id });
  } catch (err) { console.error('admin book create failed:', err.message); res.status(500).json({ error: 'Could not save the book.' }); }
});

app.put('/admin/api/books/:id', requireAdmin, async (req, res) => {
  try {
    const b = readBookBody(req.body || {}, res, false);
    if (!b) return;
    const sets = ['title=$2','author=$3','meta=$4','category=$5','price=$6','visible=$7','info=$8','rating=$9','updated_at=now()'];
    const vals = [req.params.id, b.title, b.author, b.meta, b.category, b.price, b.visible, JSON.stringify(b.info), b.rating];
    if (b.cover) { vals.push(b.cover.buf, b.cover.mime); sets.push(`cover=$${vals.length - 1}`, `cover_mime=$${vals.length}`, 'cover_v=cover_v+1'); }
    if (b.sample) { vals.push(b.sample, b.sampleName); sets.push(`sample=$${vals.length - 1}`, `sample_name=$${vals.length}`, 'sample_v=sample_v+1'); }
    else if (b.removeSample) { sets.push('sample=NULL', 'sample_name=NULL', 'sample_v=sample_v+1'); }
    const r = await pool.query(`UPDATE books SET ${sets.join(',')} WHERE id=$1`, vals);
    if (!r.rowCount) return res.status(404).json({ error: 'Book not found.' });
    await refreshCatalog();
    res.json({ ok: true });
  } catch (err) { console.error('admin book update failed:', err.message); res.status(500).json({ error: 'Could not save the book.' }); }
});

app.delete('/admin/api/books/:id', requireAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM books WHERE id=$1', [req.params.id]);
    await refreshCatalog();
    res.json({ ok: true });
  } catch (err) { console.error('admin book delete failed:', err.message); res.status(500).json({ error: 'Could not delete the book.' }); }
});

app.post('/admin/api/books-order', requireAdmin, async (req, res) => {
  try {
    const ids = Array.isArray((req.body || {}).ids) ? req.body.ids.map(String).slice(0, 500) : [];
    for (let i = 0; i < ids.length; i++) await pool.query('UPDATE books SET position=$2 WHERE id=$1', [ids[i], i]);
    await refreshCatalog();
    res.json({ ok: true });
  } catch (err) { console.error('admin order failed:', err.message); res.status(500).json({ error: 'Could not save the order.' }); }
});

// ---- Admin: page texts + delivery fees ----------------------------
app.get('/admin/api/settings', requireAdmin, async (req, res) => {
  try {
    const st = await pool.query('SELECT key, value FROM settings');
    const s = Object.fromEntries(st.rows.map(r => [r.key, r.value]));
    res.json({ texts: s.texts || null, delivery: { ...deliveryCfg, timeMog: (s.delivery && s.delivery.timeMog) || 'within 24 hours', timeOther: (s.delivery && s.delivery.timeOther) || '2 to 3 days' } });
  } catch (err) { console.error('admin settings failed:', err.message); res.status(500).json({ error: 'Could not load settings.' }); }
});

app.put('/admin/api/settings', requireAdmin, async (req, res) => {
  try {
    const body = req.body || {};
    if (body.texts) {
      const t = cleanTexts(body.texts);
      await pool.query(`INSERT INTO settings (key,value) VALUES ('texts',$1)
                        ON CONFLICT (key) DO UPDATE SET value=$1, updated_at=now()`, [JSON.stringify(t)]);
    }
    if (body.delivery) {
      const d = cleanDelivery(body.delivery, deliveryCfg);
      await pool.query(`INSERT INTO settings (key,value) VALUES ('delivery',$1)
                        ON CONFLICT (key) DO UPDATE SET value=$1, updated_at=now()`, [JSON.stringify(d)]);
    }
    await refreshCatalog();
    res.json({ ok: true });
  } catch (err) { console.error('admin settings save failed:', err.message); res.status(500).json({ error: 'Could not save.' }); }
});

// Admin page: every order in one go (the page filters, sorts and searches by itself).
app.get('/admin/api/orders-all', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM orders ORDER BY created_at DESC LIMIT 5000');
    res.json({ orders: rows.map(mapOrder) });
  } catch (err) {
    console.error('admin orders-all failed:', err.message);
    res.status(500).json({ error: 'Could not load orders.' });
  }
});

// Admin page: save a private note on an order.
app.post('/admin/api/orders/:id/notes', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'UPDATE orders SET notes = $2 WHERE id = $1 RETURNING *',
      [req.params.id, clean((req.body || {}).notes, 1000)]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Order not found.' });
    res.json({ order: mapOrder(rows[0]) });
  } catch (err) {
    console.error('admin notes failed:', err.message);
    res.status(500).json({ error: 'Could not save note.' });
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
  const t = dbTarget();
  res.json({
    server: 'ok',
    database: dbReady ? 'ok' : 'not connected',
    trying: t.error ? null : `${t.host}:${t.port}`,
    detail: dbReady ? null : dbError
  });
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
  if (pool) { connectDbWithRetry(); setInterval(() => { if (dbReady) refreshCatalog().catch(() => {}); }, 5 * 60 * 1000); }
}

module.exports = { app, deliveryFeeCents, resolveRegionId, handleOrder };
