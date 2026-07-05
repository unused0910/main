# WhatsApp CRM — Deployment Guide
# GitHub → Supabase → Render → Vercel (All Free)

---

## Project Structure

```
whatsapp-crm/
├── baileys-service/          ← Backend (deploy to Render)
│   ├── index.js              ← Main server
│   ├── package.json
│   ├── .env.example
│   └── lib/
│       ├── supabase.js       ← DB client
│       ├── session.js        ← Persistent WA session
│       ├── queue.js          ← Bulk send + pause/resume/cancel
│       └── logger.js         ← Send logs
├── frontend/
│   └── index.html            ← Full frontend (deploy to Vercel)
├── supabase/
│   └── schema.sql            ← Run this in Supabase SQL editor
├── render.yaml               ← Render blueprint config
├── vercel.json               ← Vercel routing config
└── .gitignore
```

---

## STEP 1 — Supabase Setup (5 min)

1. Go to https://supabase.com → New Project (free)
2. Wait for it to provision (~2 min)
3. Go to **SQL Editor** → paste entire contents of `supabase/schema.sql` → **Run**
4. Go to **Project Settings → API** → copy:
   - **Project URL** → this is your `SUPABASE_URL`
   - **service_role** key → this is your `SUPABASE_SERVICE_KEY` (keep secret!)

---

## STEP 2 — GitHub Setup (2 min)

```bash
# In your project folder:
git init
git add .
git commit -m "Initial commit: WhatsApp CRM v2"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/whatsapp-crm.git
git push -u origin main
```

---

## STEP 3 — Render Deployment (5 min)

1. Go to https://render.com → Sign up (free) → Connect GitHub
2. **New → Web Service** → select your `whatsapp-crm` repo
3. Configure:
   - **Name:** `whatsapp-crm-backend`
   - **Root Directory:** `baileys-service`
   - **Runtime:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Plan:** Free
4. Add **Environment Variables** (one by one):
   ```
   SUPABASE_URL          = https://YOUR_PROJECT.supabase.co
   SUPABASE_SERVICE_KEY  = your-service-role-key
   ALLOWED_ORIGIN        = https://your-app.vercel.app   (fill after Vercel deploy)
   API_SECRET            = any-long-random-string-here
   NODE_ENV              = production
   LOG_LEVEL             = warn
   ```
5. Click **Create Web Service** → wait ~3 min for first deploy
6. Copy your Render URL: `https://whatsapp-crm-backend.onrender.com`

> ⚠️ Render free tier spins down after 15 min of inactivity.
> First request after sleep takes ~30s. This is fine for a CRM —
> just open the frontend and wait a moment if it's slow.

---

## STEP 4 — Vercel Deployment (3 min)

1. Go to https://vercel.com → Sign up → Continue with GitHub
2. **Add New Project** → Import your `whatsapp-crm` repo
3. Settings:
   - **Framework Preset:** Other
   - **Root Directory:** `. (root)` (vercel.json handles routing)
4. Click **Deploy**
5. Copy your Vercel URL: `https://your-app.vercel.app`

---

## STEP 5 — Connect Frontend to Backend (1 min)

1. Open your Vercel URL in the browser
2. Go to **Settings** page in the app
3. Enter:
   - **Backend URL:** `https://whatsapp-crm-backend.onrender.com`
   - **API Secret:** the same value you set in Render's `API_SECRET`
4. Click **Save & Test** → should show ✅ Connected

---

## STEP 6 — Update ALLOWED_ORIGIN in Render (1 min)

1. Go to Render Dashboard → your service → Environment
2. Update `ALLOWED_ORIGIN` to your actual Vercel URL:
   ```
   ALLOWED_ORIGIN = https://your-app.vercel.app
   ```
3. Save → Render auto-redeploys

---

## STEP 7 — Scan WhatsApp QR (once)

1. Open your app → Dashboard
2. A QR code will appear in the WhatsApp Status card
3. On your phone: **WhatsApp → Settings → Linked Devices → Link a Device → scan**
4. Done — session is saved to Supabase permanently.
   Render can restart any number of times — no re-scan needed.

---

## Daily Usage

1. **Leads** → Add leads manually or upload CSV/Excel
2. **Templates** → Create message template with `{{name}}`, `{{product}}`, etc.
3. **Campaigns → New Campaign** → pick template + leads → click Create & Start
4. Watch live progress — pause/resume/cancel anytime
5. **History** → full log of every message

---

## Future Updates (push to auto-deploy)

```bash
git add .
git commit -m "your change"
git push
# Render and Vercel both auto-redeploy on push to main
```

---

## Troubleshooting

| Problem | Fix |
|---|---|
| Backend offline / 503 | Render free tier sleeps — wait 30s and retry |
| QR not showing | Render logs → check for Supabase connection errors |
| Session lost after restart | Confirm `whatsapp_session` table exists in Supabase |
| CORS error in browser | Set `ALLOWED_ORIGIN` in Render to your exact Vercel URL |
| "Backend URL not set" | Go to Settings → enter Render URL → Save & Test |
| Import fails | Check phone column header (should be: phone / whatsapp / mobile) |
