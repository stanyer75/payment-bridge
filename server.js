require('dotenv').config();

const express = require('express');
const axios = require('axios');
const https = require('https');
const fs = require('fs');
const cors = require('cors');

const app = express();
app.use(express.json());

// ========================
// CONFIG (EDIT THESE)
// ========================
const MGR_PASSCODE = process.env.MGR_PASSCODE;
const TERMINAL_TOKEN = process.env.TERMINAL_TOKEN;
const TERMINAL_IP = process.env.TERMINAL_IP;
const TERMINAL_TID = process.env.TERMINAL_TID;
const TERMINAL_VERSION = process.env.TERMINAL_VERSION;

const POLL_INTERVAL_MS = 1500;
const POLL_TIMEOUT_MS = 120000;
// ========================

const httpsAgent = new https.Agent({ rejectUnauthorized: false });

// --- Logging ---
function log(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  try { fs.appendFileSync("bridge.log", line); } catch (_) {}
  console.log(message);
}

// Log every request early (including OPTIONS)
app.use((req, res, next) => {
  log(`INCOMING ${req.method} ${req.url} from ${req.ip}`);
  next();
});

// --- CORS ---
app.use(cors({
  origin: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'X-MGR-PASSCODE', 'Accept'],
  exposedHeaders: ['Content-Type'],
  optionsSuccessStatus: 204,
}));

app.options(/.*/, (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,X-MGR-PASSCODE,Accept");
  res.setHeader("Access-Control-Max-Age", "86400");
  return res.sendStatus(204);
});

// --- State ---
let busy = false;
const processed = new Set(); // idempotency by payment_uuid

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function isApprovedFromCompletedBody(body) {
  // DNA doc: completed GET /transaction returns responseCode and transApproved etc. :contentReference[oaicite:2]{index=2}
  const code = String(
    body?.responseCode ??
    body?.transactionResponse?.responseCode ??
    ""
  ).toUpperCase();

  const transApproved = body?.transApproved === true || body?.approved === true;
  const transCancelled = body?.transCancelled === true;

  // Common approvals listed include 00 and 85; also offline approvals like Y1/Y3. :contentReference[oaicite:3]{index=3}
  const APPROVAL_CODES = new Set(["00", "85", "Y1", "Y3"]);
  const DENIAL_CODES = new Set(["02", "03", "05", "21", "30", "55", "63", "96", "98", "99", "Z1", "Z3"]);

  if (transCancelled) return { final: true, status: "DENIED" };
  if (transApproved) return { final: true, status: "APPROVED" };

  if (APPROVAL_CODES.has(code)) return { final: true, status: "APPROVED" };
  if (DENIAL_CODES.has(code)) return { final: true, status: "DENIED" };

  // If we got a responseCode and it's not one of the approvals, treat as denial (safer for MGR)
  if (code) return { final: true, status: "DENIED" };

  // Missing fields — treat as not final / unknown (shouldn't happen on HTTP 200, but be safe)
  return { final: false };
}

function extractAuthAndRef(body) {
  // These are optional for MGR
  const auth_code =
    body?.authorisationCode ||
    body?.authorizationCode ||
    body?.authCode ||
    body?.transactionResponse?.authorisationCode ||
    undefined;

  const txn_ref =
    body?.retrievalReferenceNumber ||
    body?.schemeReferenceData ||
    body?.paymentId ||
    body?.shortPaymentId ||
    body?.transactionResponse?.retrievalReferenceNumber ||
    undefined;

  return { auth_code, txn_ref };
}

async function notifyMGR(payment_uuid, status, auth_code, txn_ref) {
  try {
    const body = { payment_uuid, status };
    if (auth_code) body.auth_code = auth_code;
    if (txn_ref) body.txn_ref = txn_ref;

    const resp = await axios.post(
      "https://www.mygadgetrepairs.com/external/payments/custom/notify",
      body,
      {
        headers: {
          "Content-Type": "application/json",
          "X-MGR-PASSCODE": MGR_PASSCODE
        },
        timeout: 15000
      }
    );

    log(`MGR notified ${status} for ${payment_uuid} (HTTP ${resp.status})`);
  } catch (err) {
    log(`Failed to notify MGR for ${payment_uuid}: msg=${err?.message || err} http=${err?.response?.status} data=${JSON.stringify(err?.response?.data)}`);
  }
}

async function startTransaction(minorUnits, reference) {
  const url =
    `https://${TERMINAL_IP}:8080/POSitiveWebLink/${TERMINAL_VERSION}/rest/transaction` +
    `?tid=${encodeURIComponent(TERMINAL_TID)}&disablePrinting=true`;

  return axios.post(
    url,
    { transType: "SALE", amountTrans: minorUnits, reference },
    {
      headers: {
        Authorization: `Bearer ${TERMINAL_TOKEN}`,
        "Content-Type": "application/json"
      },
      httpsAgent,
      timeout: 15000
    }
  );
}

async function pollTransactionByUti(uti) {
  // Per DNA docs: poll GET /transaction with tid + uti. :contentReference[oaicite:4]{index=4}
  const url =
    `https://${TERMINAL_IP}:8080/POSitiveWebLink/${TERMINAL_VERSION}/rest/transaction` +
    `?tid=${encodeURIComponent(TERMINAL_TID)}&uti=${encodeURIComponent(uti)}`;

  return axios.get(url, {
    headers: { Authorization: `Bearer ${TERMINAL_TOKEN}` },
    httpsAgent,
    timeout: 10000,
    // allow us to handle 206 as a normal response
    validateStatus: () => true
  });
}

// --- Routes ---
app.get('/health', (req, res) => res.status(200).send("ok"));

app.post('/mgr/start-payment', async (req, res) => {
  log(`WEBHOOK headers=${JSON.stringify(req.headers)} body=${JSON.stringify(req.body)}`);

  if (req.headers['x-mgr-passcode'] !== MGR_PASSCODE) {
    log("Unauthorized webhook attempt (bad passcode)");
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  const amount = Number(req.body?.amount);
  const payment_uuid = String(req.body?.payment_uuid || "");

  if (!Number.isFinite(amount) || amount <= 0 || !payment_uuid) {
    log("Invalid payload: missing/invalid amount or payment_uuid");
    return res.status(400).json({ ok: false, error: "Invalid payload" });
  }

  // ACK MGR immediately (per MGR docs)
  res.status(202).send("Accepted");

  // Idempotency
  if (processed.has(payment_uuid)) {
    log(`Duplicate webhook ignored for payment_uuid=${payment_uuid}`);
    return;
  }

  if (busy) {
    log("Terminal busy - refusing new transaction");
    await notifyMGR(payment_uuid, "DENIED");
    return;
  }

  busy = true;
  processed.add(payment_uuid);

  const minorUnits = Math.round(amount * 100);
  log(`Starting SALE: £${amount} (${minorUnits}) payment_uuid=${payment_uuid}`);

  try {
    // 1) Start transaction (expect UTI back in body for 200/201) :contentReference[oaicite:5]{index=5}
    const startResp = await startTransaction(minorUnits, payment_uuid);
    log(`Terminal start HTTP ${startResp.status} data=${JSON.stringify(startResp.data)}`);

    const uti = startResp.data?.uti;
    if (!uti) {
      log("No UTI returned from POST /transaction; cannot poll. Denying.");
      await notifyMGR(payment_uuid, "DENIED");
      return;
    }

    // 2) Poll GET /transaction until HTTP 200 (complete) or timeout
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    let lastBody = null;

    while (Date.now() < deadline) {
      await sleep(POLL_INTERVAL_MS);

      const pollResp = await pollTransactionByUti(uti);

      // 206 = in progress (keep polling); 200 = completed :contentReference[oaicite:6]{index=6}
      log(`Poll UTI=${uti} HTTP ${pollResp.status} data=${JSON.stringify(pollResp.data)}`);
      lastBody = pollResp.data;

      if (pollResp.status === 206) continue;

      if (pollResp.status === 200) {
        const parsed = isApprovedFromCompletedBody(pollResp.data);
        if (!parsed.final) {
          // Should be final at 200, but be defensive.
          log(`HTTP 200 but not final parse; denying for safety. UTI=${uti}`);
          await notifyMGR(payment_uuid, "DENIED");
          return;
        }

        const { auth_code, txn_ref } = extractAuthAndRef(pollResp.data);
        log(`Final result UTI=${uti}: ${parsed.status}`);
        await notifyMGR(payment_uuid, parsed.status, auth_code, txn_ref);
        return;
      }

      // 404 can happen briefly if not available yet; keep polling a bit
      if (pollResp.status === 404) continue;

      // Auth/input/timeouts etc — treat as failure
      log(`Unexpected poll HTTP ${pollResp.status} for UTI=${uti}; denying.`);
      await notifyMGR(payment_uuid, "DENIED");
      return;
    }

    log(`Timed out waiting for completion. UTI=${uti} lastBody=${JSON.stringify(lastBody)}`);
    await notifyMGR(payment_uuid, "DENIED");
  } catch (err) {
    log(`Terminal error for ${payment_uuid}: msg=${err?.message || err} http=${err?.response?.status} data=${JSON.stringify(err?.response?.data)}`);
    await notifyMGR(payment_uuid, "DENIED");
  } finally {
    busy = false;
  }
});

// Catch-all
app.use((req, res) => {
  log(`NO MATCH: ${req.method} ${req.url}`);
  res.status(404).json({ ok: false, error: "Not found" });
});

app.listen(5055, () => log("Payment Bridge running on port 5055"));