// Baileys microservice — FREE self-hosted WhatsApp automation.
// Runs on YOUR computer (or a free host). The standalone CRM website talks to this
// over HTTP (http://localhost:3001) to send messages automatically, one by one,
// with random delays — no manual tap needed, zero per-message cost.
//
// IMPORTANT: This uses WhatsApp's unofficial Web protocol, not Meta's approved
// Business API. WhatsApp can detect bulk/automated sending patterns and ban the
// connected number. Keep volumes and speed human-like (the delays below already
// help, but cannot fully eliminate this risk).
//
// Setup:
//   cd baileys-service
//   npm install
//   npm start
// Scan the QR code printed in the terminal (or shown on the website) with
// WhatsApp > Linked Devices > Link a Device. Session is cached in ./auth so you
// only scan once.

import express from "express";
import cors from "cors";
import qrcode from "qrcode-terminal";
import makeWASocket, { useMultiFileAuthState, DisconnectReason } from "@whiskeysockets/baileys";

const app = express();
app.use(cors());            // allow the website (different origin) to call this local server
app.use(express.json());

let sock;
let isConnected = false;
let latestQr = null;

async function startSocket() {
  const { state, saveCreds } = await useMultiFileAuthState("./auth");
  sock = makeWASocket({ auth: state, printQRInTerminal: false });

  sock.ev.on("connection.update", (update) => {
    const { connection, qr, lastDisconnect } = update;
    if (qr) {
      latestQr = qr;
      console.log("Scan this QR code with WhatsApp > Linked Devices:");
      qrcode.generate(qr, { small: true });
    }
    if (connection === "open") {
      isConnected = true;
      latestQr = null;
      console.log("Baileys connected to WhatsApp.");
    }
    if (connection === "close") {
      isConnected = false;
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      if (shouldReconnect) startSocket();
    }
  });

  sock.ev.on("creds.update", saveCreds);
}

startSocket();

// The website polls this to show connection status + render the QR code itself
// (so you don't have to keep the terminal open) until you're connected.
app.get("/status", (_req, res) => res.json({ connected: isConnected, qr: isConnected ? null : latestQr }));

app.post("/send", async (req, res) => {
  try {
    const { to, message } = req.body;
    if (!to || !message) return res.status(400).json({ success: false, error: "Missing 'to' or 'message'" });
    if (!isConnected) return res.status(503).json({ success: false, error: "Not connected — scan the QR code first" });
    const jid = to.replace(/[^\d]/g, "") + "@s.whatsapp.net";
    const result = await sock.sendMessage(jid, { text: message });
    res.json({ success: true, id: result?.key?.id });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Baileys service listening on http://localhost:${PORT}`));
