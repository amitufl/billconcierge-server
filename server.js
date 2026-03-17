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

/* ── Bank Connect Page ────────────────────────
   Served as a regular webpage (not extension page)
   so Plaid Link CDN script loads without CSP issues
────────────────────────────────────────────── */
app.get('/connect', (req, res) => {
  const { user_id = 'user_1', api_secret } = req.query;
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>BillConcierge — Connect Bank</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{background:#0d0d0d;color:#f0f0f0;font-family:system-ui,sans-serif;
      min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
    .card{background:#161616;border:1px solid #2a2a2a;border-radius:16px;
      padding:40px;width:100%;max-width:420px;text-align:center}
    .icon{width:56px;height:56px;background:#c8f560;border-radius:14px;
      display:flex;align-items:center;justify-content:center;margin:0 auto 20px}
    h1{font-size:22px;font-weight:700;margin-bottom:8px}
    p{font-size:14px;color:#888;margin-bottom:28px;line-height:1.6}
    .btn{width:100%;padding:14px;border-radius:10px;border:none;cursor:pointer;
      font-size:15px;font-weight:700;font-family:inherit;transition:all .15s}
    .btn-primary{background:#c8f560;color:#0d0d0d}
    .btn-primary:hover{background:#a8d44a}
    .btn-primary:disabled{opacity:.4;cursor:not-allowed}
    .status{padding:14px;border-radius:10px;font-size:13px;margin-bottom:20px;
      text-align:left;line-height:1.6;display:none}
    .info{background:rgba(200,245,96,.08);border:1px solid rgba(200,245,96,.2);color:#c8f560}
    .error{background:rgba(255,95,95,.08);border:1px solid rgba(255,95,95,.3);color:#ff5f5f}
    .success{background:rgba(200,245,96,.12);border:1px solid rgba(200,245,96,.3);color:#c8f560}
  </style>
</head>
<body>
<div class="card">
  <div class="icon">
    <svg width="28" height="28" viewBox="0 0 16 16" fill="none" stroke="#0d0d0d"
      stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      <rect x="2" y="2" width="12" height="14" rx="2"/>
      <line x1="5" y1="6" x2="11" y2="6"/>
      <line x1="5" y1="9" x2="11" y2="9"/>
      <line x1="5" y1="12" x2="8" y2="12"/>
    </svg>
  </div>
  <h1>Connect your bank</h1>
  <p>Securely link your bank via Plaid to detect recurring payments automatically. Your credentials never touch BillConcierge.</p>
  <div class="status" id="status"></div>
  <button class="btn btn-primary" id="connect-btn" onclick="startLink()">Connect bank account</button>
</div>
<script src="https://cdn.plaid.com/link/v2/stable/link-initialize.js"></script>
<script>
  const userId    = ${JSON.stringify(user_id)};
  const apiSecret = ${JSON.stringify(api_secret || '')};
  const serverUrl = window.location.origin;

  function showStatus(type, msg) {
    const el = document.getElementById('status');
    el.className = 'status ' + type;
    el.textContent = msg;
    el.style.display = 'block';
  }

  async function api(method, path, body) {
    const opts = {
      method,
      headers: { 'Content-Type': 'application/json', 'x-api-secret': apiSecret }
    };
    if (body) opts.body = JSON.stringify(body);
    const res  = await fetch(serverUrl + path, opts);
    const data = await res.json();
    if (!res.ok) throw new Error(data.details || data.error || 'Server error');
    return data;
  }

  async function startLink() {
    document.getElementById('connect-btn').disabled = true;
    showStatus('info', 'Connecting to server...');
    try {
      const { link_token } = await api('POST', '/create-link-token', { user_id: userId });
      showStatus('info', 'Opening Plaid — log in to your bank...');

      const handler = Plaid.create({
        token: link_token,
        onSuccess: async (public_token) => {
          showStatus('info', 'Bank connected! Exchanging tokens...');
          try {
            await api('POST', '/exchange-token', { public_token, user_id: userId });
            showStatus('success', 'Bank linked successfully! You can close this tab and go back to the BillConcierge dashboard to fetch your transactions.');
            document.getElementById('connect-btn').style.display = 'none';
          } catch(e) {
            showStatus('error', 'Token exchange failed: ' + e.message);
            document.getElementById('connect-btn').disabled = false;
          }
        },
        onExit: (err) => {
          document.getElementById('connect-btn').disabled = false;
          if (err) showStatus('error', err.display_message || err.error_message || 'Plaid exited with error');
          else showStatus('info', 'Cancelled. Click the button to try again.');
        }
      });
      handler.open();
    } catch(e) {
      showStatus('error', 'Error: ' + e.message);
      document.getElementById('connect-btn').disabled = false;
    }
  }
</script>
</body>
</html>`);
});
