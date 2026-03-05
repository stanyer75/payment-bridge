require('dotenv').config();

const express = require('express');
const axios = require('axios');
const https = require('https');
const fs = require('fs');
const cors = require('cors');

const app = express();
app.use(express.json());

// ========================
// GLOBAL CONFIG
// ========================
const MGR_PASSCODE = process.env.MGR_PASSCODE;

const TERMINAL_VERSION = process.env.TERMINAL_VERSION || "1.2.0";

// Polling behavior
const POLL_INTERVAL_MS = 1500;
const POLL_TIMEOUT_MS = 120000;

// Two terminals (set these in .env)
const TERMINALS = {
  islandtech: {
    key: "islandtech",
    name: "Island Tech",
    ip: process.env.TERMINAL_IP_ISLANDTECH,
    tid: process.env.TERMINAL_TID_ISLANDTECH,
    token: process.env.TERMINAL_TOKEN_ISLANDTECH,
  },
  computergeeks: {
    key: "computergeeks",
    name: "The Computer Geeks",
    ip: process.env.TERMINAL_IP_COMPUTERGEEKS,
    tid: process.env.TERMINAL_TID_COMPUTERGEEKS,
    token: process.env.TERMINAL_TOKEN_COMPUTERGEEKS,
  }
};

// Validate basic config
function assertConfig() {
  if (!MGR_PASSCODE) console.warn("WARNING: MGR_PASSCODE is missing");
  for (const t of Object.values(TERMINALS)) {
    if (!t.ip || !t.tid || !t.token) {
      console.warn(`WARNING: Terminal config incomplete for ${t.key} (need IP/TID/TOKEN)`);
    }
  }
}
assertConfig();

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
// Busy lock PER TERMINAL (so both can run simultaneously on different devices)
const terminalBusy = {
  islandtech: false,
  computergeeks: false
};

// Idempotency (MGR retries can happen)
const processed = new Set(); // payment_uuid

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// Completed GET /transaction returns responseCode + transApproved flags per DNA axept® PRO docs
function isApprovedFromCompletedBody(body) {
  const code = String(
    body?.responseCode ??
    body?.transactionResponse?.responseCode ??
    ""
  ).toUpperCase();

  const transApproved = body?.transApproved === true || body?.approved === true;
  const transCancelled = body?.transCancelled === true;

  // Common approvals include 00 and 85; offline approvals can be Y1/Y3 in some setups
  const APPROVAL_CODES = new Set(["00", "85", "Y1", "Y3"]);
  const DENIAL_CODES = new Set(["02", "03", "05", "21", "30", "55", "63", "96", "98", "99", "Z1", "Z3"]);

  if (transCancelled) return { final: true, status: "DENIED" };
  if (transApproved) return { final: true, status: "APPROVED" };

  if (APPROVAL_CODES.has(code)) return { final: true, status: "APPROVED" };
  if (DENIAL_CODES.has(code)) return { final: true, status: "DENIED" };

  if (code) return { final: true, status: "DENIED" }; // any other code → deny to be safe
  return { final: false };
}

function extractAuthAndRef(body) {
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

async function startTransaction(terminal, minorUnits, reference) {
  const url =
    `https://${terminal.ip}:8080/POSitiveWebLink/${TERMINAL_VERSION}/rest/transaction` +
    `?tid=${encodeURIComponent(terminal.tid)}&disablePrinting=true`;

  return axios.post(
    url,
    { transType: "SALE", amountTrans: minorUnits, reference },
    {
      headers: {
        Authorization: `Bearer ${terminal.token}`,
        "Content-Type": "application/json"
      },
      httpsAgent,
      timeout: 15000
    }
  );
}

async function pollTransactionByUti(terminal, uti) {
  // Per DNA docs: poll GET /transaction with tid + uti
  const url =
    `https://${terminal.ip}:8080/POSitiveWebLink/${TERMINAL_VERSION}/rest/transaction` +
    `?tid=${encodeURIComponent(terminal.tid)}&uti=${encodeURIComponent(uti)}`;

  return axios.get(url, {
    headers: { Authorization: `Bearer ${terminal.token}` },
    httpsAgent,
    timeout: 10000,
    validateStatus: () => true // so we can read 206 without throwing
  });
}

// Shared handler for both payment methods
async function handleMgrPayment(req, res, terminalKey) {
  const terminal = TERMINALS[terminalKey];
  if (!terminal || !terminal.ip || !terminal.tid || !terminal.token) {
    log(`Terminal not configured for key=${terminalKey}`);
    return res.status(500).send("Terminal not configured");
  }

  log(`WEBHOOK (${terminal.name}) headers=${JSON.stringify(req.headers)} body=${JSON.stringify(req.body)}`);

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

  // ACK MGR immediately (MGR expects 202)
  res.status(202).send("Accepted");

  // Idempotency (MGR retries)
  if (processed.has(payment_uuid)) {
    log(`Duplicate webhook ignored for payment_uuid=${payment_uuid}`);
    return;
  }

  // Per-terminal busy lock
  if (terminalBusy[terminalKey]) {
    log(`Terminal busy (${terminal.name}) - refusing new transaction`);
    processed.add(payment_uuid); // prevent hammering
    await notifyMGR(payment_uuid, "DENIED");
    return;
  }

  terminalBusy[terminalKey] = true;
  processed.add(payment_uuid);

  const minorUnits = Math.round(amount * 100);
  log(`Starting SALE on ${terminal.name}: £${amount} (${minorUnits}) payment_uuid=${payment_uuid}`);

  try {
    // 1) Start transaction -> returns UTI
    const startResp = await startTransaction(terminal, minorUnits, payment_uuid);
    log(`Terminal start (${terminal.name}) HTTP ${startResp.status} data=${JSON.stringify(startResp.data)}`);

    const uti = startResp.data?.uti;
    if (!uti) {
      log(`No UTI returned from POST /transaction (${terminal.name}); denying.`);
      await notifyMGR(payment_uuid, "DENIED");
      return;
    }

    // 2) Poll GET /transaction until HTTP 200 (complete) or timeout
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    let lastBody = null;

    while (Date.now() < deadline) {
      await sleep(POLL_INTERVAL_MS);

      const pollResp = await pollTransactionByUti(terminal, uti);

      // 206 = in progress, 200 = completed
      log(`Poll (${terminal.name}) UTI=${uti} HTTP ${pollResp.status} data=${JSON.stringify(pollResp.data)}`);
      lastBody = pollResp.data;

      if (pollResp.status === 206) continue;

      if (pollResp.status === 200) {
        const parsed = isApprovedFromCompletedBody(pollResp.data);
        if (!parsed.final) {
          log(`HTTP 200 but not final parse (${terminal.name}); denying. UTI=${uti}`);
          await notifyMGR(payment_uuid, "DENIED");
          return;
        }

        const { auth_code, txn_ref } = extractAuthAndRef(pollResp.data);
        log(`Final result (${terminal.name}) UTI=${uti}: ${parsed.status}`);
        await notifyMGR(payment_uuid, parsed.status, auth_code, txn_ref);
        return;
      }

      if (pollResp.status === 404) continue; // can occur briefly

      log(`Unexpected poll HTTP ${pollResp.status} (${terminal.name}) for UTI=${uti}; denying.`);
      await notifyMGR(payment_uuid, "DENIED");
      return;
    }

    log(`Timed out waiting for completion (${terminal.name}). UTI=${uti} lastBody=${JSON.stringify(lastBody)}`);
    await notifyMGR(payment_uuid, "DENIED");

  } catch (err) {
    log(`Terminal error (${terminal.name}) for ${payment_uuid}: msg=${err?.message || err} http=${err?.response?.status} data=${JSON.stringify(err?.response?.data)}`);
    await notifyMGR(payment_uuid, "DENIED");
  } finally {
    terminalBusy[terminalKey] = false;
  }
}

// --- Routes ---
app.get('/health', (req, res) => res.status(200).send("ok"));

// Two webhook URLs (map each MGR payment method to one of these)
app.post('/mgr/islandtech/start-payment', (req, res) => handleMgrPayment(req, res, 'islandtech'));
app.post('/mgr/computergeeks/start-payment', (req, res) => handleMgrPayment(req, res, 'computergeeks'));

// Catch-all
app.use((req, res) => {
  log(`NO MATCH: ${req.method} ${req.url}`);
  res.status(404).json({ ok: false, error: "Not found" });
});

app.listen(5055, () => log("Payment Bridge running on port 5055"));