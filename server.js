require('dotenv').config();

const express = require('express');
const cors    = require('cors');
const https   = require('https');
const fs      = require('fs');

const app  = express();
const PORT = process.env.PORT || 3000;

const REQUIRED = ['TELLER_APP_ID', 'API_SECRET'];
const missing  = REQUIRED.filter(k => !process.env[k]);
if (missing.length) {
  console.error('Missing required env vars:', missing.join(', '));
  process.exit(1);
}

function getTellerAgent() {
  try {
    let cert, key;
    if (process.env.TELLER_CERT_B64 && process.env.TELLER_KEY_B64) {
      cert = Buffer.from(process.env.TELLER_CERT_B64, 'base64').toString('utf8');
      key  = Buffer.from(process.env.TELLER_KEY_B64,  'base64').toString('utf8');
    } else if (fs.existsSync('./certificate.pem') && fs.existsSync('./private_key.pem')) {
      cert = fs.readFileSync('./certificate.pem', 'utf8');
      key  = fs.readFileSync('./private_key.pem', 'utf8');
    } else {
      throw new Error('Teller certificates not found.');
    }
    return new https.Agent({ cert, key, rejectUnauthorized: true });
  } catch (err) {
    console.error('Teller cert error:', err.message);
    return null;
  }
}

async function tellerRequest(method, path, accessToken) {
  const agent = getTellerAgent();
  if (!agent) throw new Error('Teller certificate not configured');
  const { default: fetch } = await import('node-fetch');
  const res = await fetch(`https://api.teller.io${path}`, {
    method, agent,
    headers: {
      'Authorization':  'Basic ' + Buffer.from(accessToken + ':').toString('base64'),
      'Teller-Version': '2020-10-12',
    },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || `Teller error ${res.status}`);
  return data;
}

/* ─────────────────────────────────────────────
   Multi-account token store
   Key: user_id → Map of enrollment_id → { access_token, bank_name, connected_at }
───────────────────────────────────────────── */
const userAccounts = new Map();

function getAccounts(userId) {
  if (!userAccounts.has(userId)) userAccounts.set(userId, new Map());
  return userAccounts.get(userId);
}

app.use(express.json());
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'DELETE'] }));

function requireSecret(req, res, next) {
  if (req.headers['x-api-secret'] !== process.env.API_SECRET)
    return res.status(401).json({ error: 'Unauthorized' });
  next();
}

app.get('/health', (req, res) => res.json({
  status: 'ok', provider: 'teller',
  app_id: process.env.TELLER_APP_ID,
  time: new Date().toISOString(),
}));

/* ── Store token — supports multiple accounts ── */
app.post('/store-token', requireSecret, async (req, res) => {
  const { access_token, enrollment_id, user_id } = req.body;
  if (!access_token || !user_id)
    return res.status(400).json({ error: 'access_token and user_id required' });

  // Fetch the institution name + account types for display
  let bank_name = 'Bank account';
  try {
    const accounts = await tellerRequest('GET', '/accounts', access_token);
    const instName = accounts?.[0]?.institution?.name || 'Bank account';
    const hasCredit = accounts.some(a => (a.type || '').toLowerCase() === 'credit');
    const hasDeposit = accounts.some(a => (a.type || '').toLowerCase() === 'depository');
    if (hasCredit && hasDeposit) bank_name = instName + ' (Checking + Credit)';
    else if (hasCredit)          bank_name = instName + ' (Credit Card)';
    else                         bank_name = instName;
  } catch (e) { console.warn('Could not fetch institution name:', e.message); }

  const accts = getAccounts(String(user_id));
  accts.set(enrollment_id, {
    access_token,
    enrollment_id,
    bank_name,
    connected_at: new Date().toISOString(),
  });

  console.log(`Bank connected: user=${user_id} bank=${bank_name} enrollment=${enrollment_id}`);
  res.json({ success: true, bank_name });
});

/* ── Get all linked accounts for a user ── */
app.get('/accounts', requireSecret, (req, res) => {
  const { user_id } = req.query;
  if (!user_id) return res.status(400).json({ error: 'user_id required' });
  const accts = getAccounts(String(user_id));
  const list = Array.from(accts.values()).map(a => ({
    enrollment_id: a.enrollment_id,
    bank_name:     a.bank_name,
    connected_at:  a.connected_at,
  }));
  res.json({ accounts: list, total: list.length });
});

/* ── Get transactions — per account or all ── */
app.get('/transactions', requireSecret, async (req, res) => {
  const { user_id, enrollment_id } = req.query;
  if (!user_id) return res.status(400).json({ error: 'user_id required' });

  const accts = getAccounts(String(user_id));
  if (accts.size === 0) return res.status(404).json({ error: 'No bank accounts linked.' });

  // Fetch from specific account or all accounts
  const targets = enrollment_id
    ? [accts.get(enrollment_id)].filter(Boolean)
    : Array.from(accts.values());

  if (targets.length === 0) return res.status(404).json({ error: 'Account not found.' });

  try {
    const results = await Promise.all(targets.map(async (acct) => {
      const accounts  = await tellerRequest('GET', '/accounts', acct.access_token);

      // Fetch per-account transactions, preserving account type
      const txnArrays = await Promise.all(
        accounts.map(async a => {
          const txns = await tellerRequest('GET', `/accounts/${a.id}/transactions`, acct.access_token).catch(() => []);
          // Tag each transaction with its account type so we apply the right sign filter
          return txns.map(t => ({ ...t, _account_type: a.type, _account_subtype: a.subtype }));
        })
      );

      const raw  = txnArrays.flat();

      const txns = raw
        .filter(t => {
          if (t.status === 'pending') return false;
          const amt  = parseFloat(t.amount);
          const type = (t._account_type || '').toLowerCase();

          // Credit card accounts: positive = charge (money you owe = expense)
          // Depository/checking accounts: negative = debit (money leaving = expense)
          if (type === 'credit') return amt > 0;
          return amt < 0;
        })
        .map(t => ({
          transaction_id: t.id,
          date:           t.date,
          name:           t.description,
          merchant_name:  t.details?.counterparty?.name || t.description,
          amount:         Math.abs(parseFloat(t.amount)),
          currency:       'USD',
          category:       t.details?.category || null,
          account_type:   t._account_type || 'depository',
          pending:        false,
          enrollment_id:  acct.enrollment_id,
          bank_name:      acct.bank_name,
        }));

      return { enrollment_id: acct.enrollment_id, bank_name: acct.bank_name, transactions: txns };
    }));

    res.json({ accounts: results, total: results.reduce((s, r) => s + r.transactions.length, 0) });
  } catch (err) {
    console.error('transactions error:', err.message);
    res.status(500).json({ error: 'Failed to fetch transactions', details: err.message });
  }
});

/* ── Status ── */
app.get('/status', requireSecret, (req, res) => {
  const { user_id } = req.query;
  const accts = user_id ? getAccounts(String(user_id)) : new Map();
  const list  = Array.from(accts.values()).map(a => ({
    enrollment_id: a.enrollment_id,
    bank_name:     a.bank_name,
    connected_at:  a.connected_at,
  }));
  res.json({ connected: list.length > 0, accounts: list, total: list.length });
});

/* ── Disconnect one account ── */
app.post('/disconnect', requireSecret, async (req, res) => {
  const { user_id, enrollment_id } = req.body;
  if (!user_id) return res.status(400).json({ error: 'user_id required' });

  const accts = getAccounts(String(user_id));

  if (enrollment_id) {
    // Disconnect specific account
    const acct = accts.get(enrollment_id);
    if (acct) {
      try {
        await tellerRequest('DELETE', `/enrollments/${enrollment_id}`, acct.access_token);
      } catch (e) { console.warn('Teller disconnect:', e.message); }
      accts.delete(enrollment_id);
    }
  } else {
    // Disconnect all accounts
    for (const [eid, acct] of accts) {
      try {
        await tellerRequest('DELETE', `/enrollments/${eid}`, acct.access_token);
      } catch (e) { console.warn('Teller disconnect:', e.message); }
    }
    accts.clear();
  }

  res.json({ success: true });
});

/* ── Connect page ── */
app.get('/connect', (req, res) => {
  const { user_id = 'user_1', api_secret = '' } = req.query;
  const appId = process.env.TELLER_APP_ID;
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
      font-size:15px;font-weight:700;font-family:inherit;transition:all .15s;margin-top:10px}
    .btn-primary{background:#c8f560;color:#0d0d0d}
    .btn-primary:hover{background:#a8d44a}
    .btn-primary:disabled{opacity:.4;cursor:not-allowed}
    .status{padding:14px;border-radius:10px;font-size:13px;margin-bottom:16px;
      text-align:left;line-height:1.6;display:none}
    .info{background:rgba(200,245,96,.08);border:1px solid rgba(200,245,96,.2);color:#c8f560}
    .error{background:rgba(255,95,95,.08);border:1px solid rgba(255,95,95,.3);color:#ff5f5f}
    .success{background:rgba(200,245,96,.12);border:1px solid rgba(200,245,96,.3);color:#c8f560;font-weight:500}
    .connected-list{text-align:left;margin-bottom:20px;display:none}
    .connected-list h3{font-size:12px;font-weight:600;letter-spacing:.8px;text-transform:uppercase;
      color:#666;margin-bottom:10px}
    .acct-row{display:flex;align-items:center;justify-content:space-between;
      padding:10px 12px;background:#1e1e1e;border-radius:8px;margin-bottom:6px;font-size:13px}
    .acct-dot{width:7px;height:7px;border-radius:50%;background:#c8f560;margin-right:8px;flex-shrink:0}
    .acct-name{flex:1}
    .acct-date{font-size:11px;color:#666}
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
  <p>Link one or more bank accounts or credit cards. Your credentials never touch BillConcierge.</p>
  <div id="connected-list" class="connected-list">
    <h3>Connected accounts</h3>
    <div id="acct-rows"></div>
  </div>
  <div class="status" id="status"></div>
  <button class="btn btn-primary" id="connect-btn">Connect another account</button>
</div>
<script src="https://cdn.teller.io/connect/connect.js"></script>
<script>
  const userId    = ${JSON.stringify(user_id)};
  const apiSecret = ${JSON.stringify(api_secret)};
  const serverUrl = window.location.origin;

  function showStatus(type, msg) {
    const el = document.getElementById('status');
    el.className = 'status ' + type;
    el.textContent = msg;
    el.style.display = 'block';
  }

  async function loadConnected() {
    try {
      const res  = await fetch(serverUrl + '/status?user_id=' + userId, {
        headers: { 'x-api-secret': apiSecret }
      });
      const data = await res.json();
      if (data.accounts && data.accounts.length > 0) {
        document.getElementById('connected-list').style.display = 'block';
        document.getElementById('acct-rows').innerHTML = data.accounts.map(a =>
          '<div class="acct-row">' +
          '<span class="acct-dot"></span>' +
          '<span class="acct-name">' + a.bank_name + '</span>' +
          '<span class="acct-date">Connected ' + new Date(a.connected_at).toLocaleDateString() + '</span>' +
          '</div>'
        ).join('');
        document.getElementById('connect-btn').textContent = 'Connect another account';
      } else {
        document.getElementById('connect-btn').textContent = 'Connect bank account';
      }
    } catch(e) {}
  }

  loadConnected();

  document.getElementById('connect-btn').addEventListener('click', () => {
    const tc = TellerConnect.setup({
      applicationId: ${JSON.stringify(appId)},
      environment:   'development',
      products:      ['transactions'],
      onSuccess: async (enrollment) => {
        showStatus('info', 'Bank connected! Saving...');
        document.getElementById('connect-btn').disabled = true;
        try {
          const res = await fetch(serverUrl + '/store-token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-secret': apiSecret },
            body: JSON.stringify({
              access_token:  enrollment.accessToken,
              enrollment_id: enrollment.enrollment.id,
              user_id:       userId,
            }),
          });
          const data = await res.json();
          if (!res.ok) throw new Error('Server error');
          showStatus('success',
            (data.bank_name || 'Bank') + ' linked! Close this tab and return to BillConcierge, then click "I connected my bank — fetch transactions".');
          await loadConnected();
          document.getElementById('connect-btn').disabled = false;
        } catch(e) {
          showStatus('error', 'Failed to save: ' + e.message);
          document.getElementById('connect-btn').disabled = false;
        }
      },
      onExit: () => showStatus('info', 'Cancelled. Click the button to try again.'),
      onFailure: (f) => showStatus('error', 'Failed: ' + (f.message || 'Unknown error')),
    });
    tc.open();
  });
</script>
</body>
</html>`);
});

app.listen(PORT, () => {
  console.log('BillConcierge server on port ' + PORT + ' — Teller multi-account');
  console.log('Health: http://localhost:' + PORT + '/health');
});
