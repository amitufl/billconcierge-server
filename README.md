# BillConcierge Backend Server

Express.js server that handles Plaid bank integration securely.

## Deploy to Railway (free, 5 minutes)

### Step 1 — Push to GitHub
1. Create a new GitHub repo (e.g. `billconcierge-server`)
2. Push this entire folder to it:
```bash
cd billconcierge-server
git init
git add .
git commit -m "Initial server"
git remote add origin https://github.com/YOUR_USERNAME/billconcierge-server.git
git push -u origin main
```

### Step 2 — Deploy on Railway
1. Go to railway.app → New Project → Deploy from GitHub repo
2. Select your `billconcierge-server` repo
3. Railway auto-detects Node.js and deploys it

### Step 3 — Add environment variables
In Railway dashboard → your project → Variables tab, add:
```
PLAID_CLIENT_ID     = your_client_id_from_plaid_dashboard
PLAID_SECRET        = your_sandbox_secret_from_plaid_dashboard
PLAID_ENV           = sandbox
API_SECRET          = any_random_string_you_choose (e.g. "bc-secret-abc123")
```

### Step 4 — Get your server URL
Railway gives you a URL like `https://billconcierge-server-production.up.railway.app`
Copy this — you'll paste it into the extension when you click "Link Bank".

### Step 5 — Verify it works
Open `https://your-url.railway.app/health` in your browser.
You should see: `{"status":"ok","env":"sandbox",...}`

## Local development
```bash
cp .env.example .env
# Fill in your values in .env
npm install
npm run dev
```

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | /health | Server health check |
| POST | /create-link-token | Get Plaid Link token |
| POST | /exchange-token | Exchange public_token for access_token |
| GET | /transactions | Fetch 90 days of transactions |
| GET | /status | Check if user has linked bank |
| POST | /disconnect | Remove bank connection |

All endpoints except /health require `x-api-secret` header matching your API_SECRET env var.

## Moving to production (Plaid)
When ready to go live:
1. Apply for Plaid production access at dashboard.plaid.com
2. Change PLAID_ENV=production and update PLAID_SECRET to your production secret
3. Replace the in-memory tokenStore with a real database (Postgres recommended)
