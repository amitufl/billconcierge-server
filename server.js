require('dotenv').config();

const express    = require('express');
const cors       = require('cors');
const { PlaidApi, PlaidEnvironments, Configuration, Products, CountryCode } = require('plaid');

const app  = express();
const PORT = process.env.PORT || 3000;

/* ─────────────────────────────────────────────
   Validate env vars on startup
───────────────────────────────────────────── */
const REQUIRED = ['PLAID_CLIENT_ID', 'PLAID_SECRET', 'PLAID_ENV', 'API_SECRET'];
const missing  = REQUIRED.filter(k => !process.env[k]);
if (missing.length) {
  console.error('Missing required env vars:', missing.join(', '));
  console.error('Copy .env.example to .env and fill in your values.');
  process.exit(1);
}

/* ─────────────────────────────────────────────
   Plaid client
───────────────────────────────────────────── */
const plaidConfig = new Configuration({
  basePath: PlaidEnvironments[process.env.PLAID_ENV],
  baseOptions: {
    headers: {
      'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID,
      'PLAID-SECRET':    process.env.PLAID_SECRET,
    },
  },
});
const plaidClient = new PlaidApi(plaidConfig);

/* ─────────────────────────────────────────────
   In-memory token store
   For SaaS: replace with a real database (Postgres, Mongo, etc.)
   Key: user_id  →  Value: plaid access_token
───────────────────────────────────────────── */
const tokenStore = new Map();

/* ─────────────────────────────────────────────
   Middleware
───────────────────────────────────────────── */
app.use(express.json());
app.use(cors({
  origin: '*',  // Tighten this to your extension ID in production
  methods: ['GET', 'POST'],
}));

// Simple API key guard — every request must include x-api-secret header
function requireSecret(req, res, next) {
  const secret = req.headers['x-api-secret'];
  if (!secret || secret !== process.env.API_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

/* ─────────────────────────────────────────────
   Routes
───────────────────────────────────────────── */

// Health check — useful for Railway deploy verification
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    env:    process.env.PLAID_ENV,
    time:   new Date().toISOString(),
  });
});

/* ── 1. Create Link Token ──────────────────────
   Extension calls this first to get a link_token.
   The link_token is safe to expose to the browser —
   it has a short TTL and can only be used once.
────────────────────────────────────────────── */
app.post('/create-link-token', requireSecret, async (req, res) => {
  const { user_id } = req.body;

  if (!user_id) {
    return res.status(400).json({ error: 'user_id is required' });
  }

  try {
    const response = await plaidClient.linkTokenCreate({
      user:          { client_user_id: String(user_id) },
      client_name:   'BillConcierge',
      products:      [Products.Transactions],
      country_codes: [CountryCode.Us],
      language:      'en',
    });

    res.json({ link_token: response.data.link_token });

  } catch (err) {
    console.error('create-link-token error:', err.response?.data || err.message);
    res.status(500).json({
      error:   'Failed to create link token',
      details: err.response?.data?.error_message || err.message,
    });
  }
});

/* ── 2. Exchange Public Token ──────────────────
   After the user connects their bank, Plaid gives
   the extension a public_token. We exchange it for
   a permanent access_token server-side.
   The access_token NEVER leaves the server.
────────────────────────────────────────────── */
app.post('/exchange-token', requireSecret, async (req, res) => {
  const { public_token, user_id } = req.body;

  if (!public_token || !user_id) {
    return res.status(400).json({ error: 'public_token and user_id are required' });
  }

  try {
    const response = await plaidClient.itemPublicTokenExchange({ public_token });
    const access_token = response.data.access_token;
    const item_id      = response.data.item_id;

    // Store the access_token mapped to user_id
    // In production: save to your database instead
    tokenStore.set(String(user_id), { access_token, item_id, connected_at: new Date().toISOString() });

    console.log(`Bank connected for user ${user_id}, item_id: ${item_id}`);
    res.json({ success: true, item_id });

  } catch (err) {
    console.error('exchange-token error:', err.response?.data || err.message);
    res.status(500).json({
      error:   'Failed to exchange token',
      details: err.response?.data?.error_message || err.message,
    });
  }
});

/* ── 3. Get Transactions ───────────────────────
   Fetches 90 days of transactions for a user.
   Returns raw transaction list — Claude in the
   extension will analyze these for recurring payments.
────────────────────────────────────────────── */
app.get('/transactions', requireSecret, async (req, res) => {
  const { user_id } = req.query;

  if (!user_id) {
    return res.status(400).json({ error: 'user_id is required' });
  }

  const stored = tokenStore.get(String(user_id));
  if (!stored) {
    return res.status(404).json({
      error: 'No bank account linked for this user. Connect a bank first.',
    });
  }

  try {
    const today    = new Date();
    const ninetyDaysAgo = new Date(today);
    ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);

    const fmt = d => d.toISOString().split('T')[0];

    const response = await plaidClient.transactionsGet({
      access_token: stored.access_token,
      start_date:   fmt(ninetyDaysAgo),
      end_date:     fmt(today),
      options:      { count: 500, offset: 0 },
    });

    const txns = response.data.transactions.map(t => ({
      transaction_id: t.transaction_id,
      date:           t.date,
      name:           t.name,
      merchant_name:  t.merchant_name || t.name,
      amount:         t.amount,        // Positive = money out (expense)
      currency:       t.iso_currency_code || 'USD',
      category:       t.category?.[0] || null,
      pending:        t.pending,
    }));

    res.json({
      transactions:   txns,
      total:          txns.length,
      start_date:     fmt(ninetyDaysAgo),
      end_date:       fmt(today),
      connected_at:   stored.connected_at,
    });

  } catch (err) {
    console.error('transactions error:', err.response?.data || err.message);
    res.status(500).json({
      error:   'Failed to fetch transactions',
      details: err.response?.data?.error_message || err.message,
    });
  }
});

/* ── 4. Check connection status ───────────────── */
app.get('/status', requireSecret, async (req, res) => {
  const { user_id } = req.query;
  const stored = user_id ? tokenStore.get(String(user_id)) : null;
  res.json({
    connected:    !!stored,
    connected_at: stored?.connected_at || null,
    item_id:      stored?.item_id || null,
  });
});

/* ── 5. Disconnect bank ───────────────────────── */
app.post('/disconnect', requireSecret, async (req, res) => {
  const { user_id } = req.body;
  if (!user_id) return res.status(400).json({ error: 'user_id required' });

  const stored = tokenStore.get(String(user_id));
  if (stored) {
    try {
      await plaidClient.itemRemove({ access_token: stored.access_token });
    } catch (e) {
      console.warn('Plaid item remove failed (non-fatal):', e.message);
    }
    tokenStore.delete(String(user_id));
  }

  res.json({ success: true });
});

/* ─────────────────────────────────────────────
   Start
───────────────────────────────────────────── */
app.listen(PORT, () => {
  console.log(`BillConcierge server running on port ${PORT}`);
  console.log(`Plaid environment: ${process.env.PLAID_ENV}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
});
