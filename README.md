# Setup Instructions — CRM + WhatsApp Outreach (Free Auto-Send Edition)

## 1. Open the website
Double-click `CRM-WhatsApp-Outreach.html` — it opens in your browser, no install needed.

## 2. Start the auto-sender (one-time, ~5 minutes)
You need [Node.js](https://nodejs.org) installed (free) on the same computer.

```bash
cd baileys-service
npm install
npm start
```

A QR code appears in the terminal. On your phone:
**WhatsApp → Settings → Linked Devices → Link a Device** → scan it.

Leave this terminal running in the background. You only scan once — your session
is saved in `baileys-service/auth`.

## 3. Connect the website to it
In the website: **Settings → Sending** tab → under "Automatic Mode" the URL should
already say `http://localhost:3001` (default, no change needed if same computer) →
click **Check Connection** → should show 🟢 Connected.

## 4. Use it
1. **Leads** → add leads or bulk-upload a CSV
2. **Templates** → create/edit your message template
3. **Campaigns → New Campaign** → pick template + leads → Create & Queue
4. Inside the campaign, click **🚀 Auto-Send All (Free, via Baileys)**
5. Done — it sends one by one automatically with random 15–35s delays, no further clicks.

## ⚠️ Risk reminder
This uses WhatsApp's unofficial protocol, not Meta's approved Business API.
WhatsApp can ban a number it detects sending automated bulk messages. Start with
small batches (20–30/day) and slow delays to reduce (not eliminate) this risk.
