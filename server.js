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
      throw new Error('Teller certificates not found. Set TELLER_CERT_B64 and TELLER_KEY_B64 env vars.');
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

const tokenStore = new Map();

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

app.post('/store-token', requireSecret, (req, res) => {
  const { access_token, enrollment_id, user_id } = req.body;
  if (!access_token || !user_id)
    return res.status(400).json({ error: 'access_token and user_id required' });
  tokenStore.set(String(user_id), {
    access_token, enrollment_id: enrollment_id || null,
    connected_at: new Date().toISOString(),
  });
  console.log(`Bank connected: user=${user_id} enrollment=${enrollment_id}`);
  res.json({ success: true });
});

app.get('/transactions', requireSecret, async (req, res) => {
  const { user_id } = req.query;
  if (!user_id) return res.status(400).json({ error: 'user_id required' });
  const stored = tokenStore.get(String(user_id));
  if (!stored) return res.status(404).json({ error: 'No bank account linked.' });
  try {
    const accounts = await tellerRequest('GET', '/accounts', stored.access_token);
    const txnArrays = await Promise.all(
      accounts.map(a =>
        tellerRequest('GET', `/accounts/${a.id}/transactions`, stored.access_token).catch(() => [])
      )
    );
    const raw  = txnArrays.flat();
    const txns = raw
      .filter(t => parseFloat(t.amount) < 0 && t.status !== 'pending')
      .map(t => ({
        transaction_id: t.id,
        date:           t.date,
        name:           t.description,
        merchant_name:  t.details?.counterparty?.name || t.description,
        amount:         Math.abs(parseFloat(t.amount)),
        currency:       'USD',
        category:       t.details?.category || null,
        pending:        false,
      }));
    res.json({ transactions: txns, total: txns.length, connected_at: stored.connected_at });
  } catch (err) {
    console.error('transactions error:', err.message);
    res.status(500).json({ error: 'Failed to fetch transactions', details: err.message });
  }
});

app.get('/status', requireSecret, (req, res) => {
  const stored = req.query.user_id ? tokenStore.get(String(req.query.user_id)) : null;
  res.json({ connected: !!stored, connected_at: stored?.connected_at || null, provider: 'teller' });
});

app.post('/disconnect', requireSecret, async (req, res) => {
  const { user_id } = req.body;
  if (!user_id) return res.status(400).json({ error: 'user_id required' });
  const stored = tokenStore.get(String(user_id));
  if (stored) {
    if (stored.enrollment_id) {
      try {
        await tellerRequest('DELETE', `/enrollments/${stored.enrollment_id}`, stored.access_token);
      } catch (e) { console.warn('Teller disconnect:', e.message); }
    }
    tokenStore.delete(String(user_id));
  }
  res.json({ success: true });
});

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
      font-size:15px;font-weight:700;font-family:inherit;transition:all .15s}
    .btn-primary{background:#c8f560;color:#0d0d0d}
    .btn-primary:hover{background:#a8d44a}
    .btn-primary:disabled{opacity:.4;cursor:not-allowed}
    .status{padding:14px;border-radius:10px;font-size:13px;margin-bottom:20px;
      text-align:left;line-height:1.6;display:none}
    .info{background:rgba(200,245,96,.08);border:1px solid rgba(200,245,96,.2);color:#c8f560}
    .error{background:rgba(255,95,95,.08);border:1px solid rgba(255,95,95,.3);color:#ff5f5f}
    .success{background:rgba(200,245,96,.12);border:1px solid rgba(200,245,96,.3);color:#c8f560;font-weight:500}
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
  <p>Securely link your real bank account via Teller. Your login credentials never touch BillConcierge.</p>
  <div class="status" id="status"></div>
  <button class="btn btn-primary" id="connect-btn">Connect bank account</button>
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
          if (!res.ok) throw new Error('Server error');
          showStatus('success', 'Bank linked! Close this tab and return to BillConcierge, then click "I connected my bank — fetch transactions".');
          document.getElementById('connect-btn').style.display = 'none';
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
  console.log(`BillConcierge server on port ${PORT} — Teller`);
  console.log(`Health: http://localhost:${PORT}/health`);
});
