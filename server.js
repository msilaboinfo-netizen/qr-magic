/**
 * Personal QR show: ordered queries → each scan redirects (e.g. Google) and advances counter.
 * No user accounts: ADMIN_TOKEN protects / and /api/* ; PUBLIC_TOKEN is the /r/:slug path.
 */
require("dotenv").config();

/** Fly.io / Render / Railway などで .env なしでも観客用の https オリジンを推測 */
function applyHostedPublicBaseUrl() {
  if ((process.env.PUBLIC_BASE_URL || "").trim()) return;
  if (process.env.FLY_APP_NAME) {
    process.env.PUBLIC_BASE_URL = `https://${process.env.FLY_APP_NAME}.fly.dev`;
    return;
  }
  if (process.env.RENDER_EXTERNAL_URL) {
    process.env.PUBLIC_BASE_URL = process.env.RENDER_EXTERNAL_URL.replace(/\/+$/, "");
    return;
  }
  if (process.env.RAILWAY_PUBLIC_DOMAIN) {
    process.env.PUBLIC_BASE_URL = `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
  }
}
applyHostedPublicBaseUrl();

const fs = require("fs");
const path = require("path");
const express = require("express");

const PORT = Number(process.env.PORT || 3333);
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "dev-admin-change-me";
const PUBLIC_TOKEN = process.env.PUBLIC_TOKEN || "dev-public-change-me";

const DATA_DIR = path.join(__dirname, "data");
const STATE_FILE = path.join(DATA_DIR, "state.json");
const TUNNEL_URL_FILE = path.join(DATA_DIR, "tunnel-url.txt");

/** 観客用の https オリジン（末尾スラッシュなし）。.env の PUBLIC_BASE_URL 優先、なければ tunnel-only が書いたファイル */
function getPublicBaseUrl() {
  const fromEnv = (process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, "").trim();
  if (fromEnv) return fromEnv;
  try {
    if (fs.existsSync(TUNNEL_URL_FILE)) {
      const line = fs.readFileSync(TUNNEL_URL_FILE, "utf8").trim().split(/\r?\n/)[0];
      if (line && /^https?:\/\//i.test(line)) return line.replace(/\/+$/, "");
    }
  } catch (_) {}
  return "";
}

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function defaultState() {
  return {
    queries: ["", "", ""],
    counter: 0,
    performanceActive: false,
    permanent: false,
    /** Placeholders: {query} required. Optional {host} */
    serviceTemplate: "https://www.google.com/search?q={query}",
  };
}

function readState() {
  ensureDataDir();
  if (!fs.existsSync(STATE_FILE)) {
    const s = defaultState();
    writeState(s);
    return s;
  }
  try {
    const raw = fs.readFileSync(STATE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return { ...defaultState(), ...parsed };
  } catch {
    return defaultState();
  }
}

function writeState(state) {
  ensureDataDir();
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
}

function adminAuth(req, res, next) {
  const auth = req.headers.authorization || "";
  const want = `Bearer ${ADMIN_TOKEN}`;
  if (auth !== want) {
    return res.status(401).json({ ok: false, message: "Unauthorized" });
  }
  next();
}

function buildUrl(template, query, req) {
  const host = `${req.protocol}://${req.get("host")}`;
  return template
    .replaceAll("{host}", host)
    .replaceAll("{query}", encodeURIComponent(query));
}

const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "512kb" }));

/** 管理画面のQR用。トークンはQRに載る想定のため公開してよい情報のみ */
app.get("/api/public-qr-hint", (req, res) => {
  const base = getPublicBaseUrl();
  res.json({
    publicBaseUrl: base || null,
    publicPath: `/r/${PUBLIC_TOKEN}`,
  });
});

/** Spectator scan */
app.get("/r/:token", (req, res) => {
  if (req.params.token !== PUBLIC_TOKEN) {
    return res.status(404).send("Not found");
  }
  const state = readState();
  if (!state.performanceActive) {
    return res.status(200).type("html").send(`<!DOCTYPE html>
<html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Show</title></head>
<body style="font-family:sans-serif;padding:1.5rem;line-height:1.6;max-width:28rem">
<p style="font-size:1.25rem;font-weight:bold">準備中です</p>
<p>このURLは、管理画面（トップ）で <strong>「パフォーマンス」</strong> を押してから有効になります。</p>
<p style="color:#555;font-size:.9rem">キーワードを入れたあと <strong>「設定を保存」</strong> も忘れずに。</p>
</body></html>`);
  }

  const queries = Array.isArray(state.queries) ? state.queries : [];
  const slots = queries
    .map((q, i) => ({ i, q: String(q || "").trim() }))
    .filter((x) => x.q.length > 0);
  if (slots.length === 0) {
    return res.status(503).type("html").send("<!DOCTYPE html><html lang=ja><meta charset=utf-8><body>キーワードが未設定です。</body></html>");
  }

  const pick = slots[state.counter % slots.length];
  const query = pick.q;
  const url = buildUrl(state.serviceTemplate || defaultState().serviceTemplate, query, req);

  state.counter = (state.counter || 0) + 1;
  writeState(state);
  return res.redirect(302, url);
});

/** Admin API */
app.get("/api/state", adminAuth, (req, res) => {
  const state = readState();
  res.json({
    ok: true,
    publicPath: `/r/${PUBLIC_TOKEN}`,
    publicToken: PUBLIC_TOKEN,
    publicBaseUrl: getPublicBaseUrl() || null,
    state: {
      queries: state.queries,
      counter: state.counter,
      performanceActive: state.performanceActive,
      permanent: state.permanent,
      serviceTemplate: state.serviceTemplate,
    },
  });
});

app.put("/api/state", adminAuth, (req, res) => {
  const cur = readState();
  const body = req.body || {};
  let serviceTemplate = cur.serviceTemplate;
  if (typeof body.serviceTemplate === "string" && body.serviceTemplate.includes("{query}")) {
    serviceTemplate = body.serviceTemplate;
  }
  const next = {
    ...cur,
    queries: Array.isArray(body.queries) ? body.queries.map((q) => String(q)) : cur.queries,
    serviceTemplate,
  };
  writeState(next);
  res.json({ ok: true, state: next });
});

app.post("/api/performance", adminAuth, (req, res) => {
  const cur = readState();
  const action = req.body && req.body.action;
  if (action === "start") {
    cur.performanceActive = true;
    cur.permanent = Boolean(req.body.permanent);
    writeState(cur);
    return res.json({ ok: true, state: cur });
  }
  if (action === "end") {
    cur.performanceActive = false;
    if (!cur.permanent) {
      cur.counter = 0;
    }
    cur.permanent = false;
    writeState(cur);
    return res.json({ ok: true, state: cur });
  }
  return res.status(400).json({ ok: false, message: "action must be start|end" });
});

app.post("/api/reset-counter", adminAuth, (req, res) => {
  const cur = readState();
  cur.counter = 0;
  writeState(cur);
  res.json({ ok: true, state: cur });
});

app.use(express.static(path.join(__dirname, "public")));

app.use((req, res) => {
  if (req.path.startsWith("/api/")) {
    return res.status(404).json({ ok: false });
  }
  res.status(404).send("Not found");
});

app.listen(PORT, () => {
  console.log(`QR magic listening on http://localhost:${PORT}`);
  console.log(`Admin: open http://localhost:${PORT}/  (Bearer ADMIN_TOKEN)`);
  const localPublic = `http://localhost:${PORT}/r/${PUBLIC_TOKEN}`;
  console.log(`Public QR path (local): ${localPublic}`);
  const pub = getPublicBaseUrl();
  if (pub) {
    console.log(`Public QR path (internet): ${pub}/r/${PUBLIC_TOKEN}`);
  } else {
    console.log(`Internet (かんたん): npm.cmd run public`);
  }
});
