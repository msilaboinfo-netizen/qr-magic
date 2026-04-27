/**
 * Personal QR: name-card URLs bind on first scan; admin is ADMIN_TOKEN.
 * Legacy /r/PUBLIC_TOKEN is retired (404). Tickets use /r/:randomToken.
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
const crypto = require("crypto");
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
    queries: [""],
    /** legacy fields ignored by current app; kept in JSON for older state files */
    counter: 0,
    performanceActive: false,
    permanent: false,
    /** Placeholders: {query} required. Optional {host} */
    serviceTemplate: "https://www.google.com/search?q={query}",
    /**
     * 名刺用: トークン → { query, template }
     * query が null/空のときは「未割当」→ 初回GETでその時点のキーワード（queries の先頭の非空）を保存して固定
     * template が null のときは常に state.serviceTemplate を使う（将来の変更に追従）
     */
    tickets: {},
  };
}

/** キーワードは1語だけ。旧データの複数行は先頭の非空1つに畳む */
function normalizeQueriesToSingle(queries) {
  const arr = Array.isArray(queries) ? queries : [""];
  for (const q of arr) {
    const s = String(q || "").trim();
    if (s.length > 0) return [s];
  }
  return [""];
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
    const merged = { ...defaultState(), ...parsed };
    merged.queries = normalizeQueriesToSingle(merged.queries);
    return merged;
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

/** 名刺の「いまの単語」: キーワード欄の上から最初の非空（マジシャンがスマホで入れた1語想定） */
function firstNonEmptyQuery(state) {
  const queries = Array.isArray(state.queries) ? state.queries : [];
  for (const q of queries) {
    const s = String(q || "").trim();
    if (s.length > 0) return s;
  }
  return null;
}

function ticketQueryBound(t) {
  if (!t || t.query == null) return false;
  return String(t.query).trim().length > 0;
}

const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "512kb" }));

/** トンネル等で観客用オリジンが決まったら管理画面がポーリングする（URL表示は廃止済み） */
app.get("/api/public-qr-hint", (req, res) => {
  const base = getPublicBaseUrl();
  res.json({ ok: true, publicBaseUrl: base || null });
});

/** Spectator scan */
app.get("/r/:token", (req, res) => {
  const token = req.params.token;
  const state = readState();
  const tickets = state.tickets && typeof state.tickets === "object" ? state.tickets : {};

  /** 名刺用: 初回スキャンで「そのとき管理画面のキーワード」を保存し、以後ずっと同じ検索へ */
  if (tickets[token]) {
    const t = tickets[token];
    if (!ticketQueryBound(t)) {
      const live = firstNonEmptyQuery(state);
      if (!live) {
        return res.status(503).type("html").send(`<!DOCTYPE html>
<html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>名刺QR</title></head>
<body style="font-family:sans-serif;padding:1.5rem;line-height:1.6;max-width:28rem">
<p style="font-size:1.1rem;font-weight:bold">まだ単語が入っていません</p>
<p>マジシャン側の管理画面で、キーワードを入力して <strong>「設定を保存」</strong> してから、もう一度このQRを読み取ってください。</p>
<p style="color:#555;font-size:.9rem">この名刺用URLは、初めて読まれたときの単語に固定されます。</p>
</body></html>`);
      }
      t.query = live;
      writeState(state);
    }
    const tmpl =
      t.template && String(t.template).includes("{query}")
        ? String(t.template)
        : state.serviceTemplate || defaultState().serviceTemplate;
    const url = buildUrl(tmpl, String(t.query || "").trim(), req);
    return res.redirect(302, url);
  }

  if (token === PUBLIC_TOKEN) {
    return res.status(404).type("html").send(`<!DOCTYPE html>
<html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>QR</title></head>
<body style="font-family:sans-serif;padding:1.5rem;line-height:1.6;max-width:28rem">
<p style="font-size:1.1rem;font-weight:bold">この共通URLは使われていません</p>
<p>名刺用に発行した<strong>それぞれ違うURL</strong>のQRを読み取ってください。</p>
</body></html>`);
  }

  return res.status(404).send("Not found");
});

/** Admin API */
app.get("/api/state", adminAuth, (req, res) => {
  const state = readState();
  res.json({
    ok: true,
    publicBaseUrl: getPublicBaseUrl() || null,
    state: {
      queries: state.queries,
      serviceTemplate: state.serviceTemplate,
      ticketCount: Object.keys(state.tickets || {}).length,
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
    queries: normalizeQueriesToSingle(Array.isArray(body.queries) ? body.queries.map((q) => String(q)) : cur.queries),
    serviceTemplate,
  };
  writeState(next);
  res.json({
    ok: true,
    state: { ...next, ticketCount: Object.keys(next.tickets || {}).length },
  });
});

/** 名刺用URLを count 枚ぶん発行（単語は未割当→初回スキャン時にそのときのキーワードで固定） */
app.post("/api/tickets/bulk", adminAuth, (req, res) => {
  const raw = parseInt(req.body && req.body.count, 10);
  const count = Math.min(5000, Math.max(1, Number.isFinite(raw) ? raw : 0));
  if (!count) {
    return res.status(400).json({ ok: false, message: "count は 1〜5000" });
  }
  const cur = readState();
  if (!cur.tickets || typeof cur.tickets !== "object") cur.tickets = {};
  const created = [];
  for (let i = 0; i < count; i++) {
    let tok;
    let guard = 0;
    do {
      tok = crypto.randomBytes(12).toString("hex");
      guard++;
    } while ((tok === PUBLIC_TOKEN || cur.tickets[tok]) && guard < 50);
    if (guard >= 50) {
      return res.status(500).json({ ok: false, message: "トークン生成に失敗しました" });
    }
    cur.tickets[tok] = { query: null, template: null };
    created.push({ token: tok, path: `/r/${tok}` });
  }
  writeState(cur);
  res.json({ ok: true, tickets: created, ticketCount: Object.keys(cur.tickets).length });
});

/** 名刺用URLをすべて削除（確認用に body.confirm が true） */
app.post("/api/tickets/clear", adminAuth, (req, res) => {
  if (!(req.body && req.body.confirm === true)) {
    return res.status(400).json({ ok: false, message: "body.confirm true が必要です" });
  }
  const cur = readState();
  cur.tickets = {};
  writeState(cur);
  res.json({ ok: true, ticketCount: 0 });
});

const PUBLIC_DIR = path.join(__dirname, "public");

/** 管理画面HTML: public → plain の embedded-index.html → 最後に embedded-index.js */
function loadAdminIndexHtml() {
  try {
    return fs.readFileSync(path.join(PUBLIC_DIR, "index.html"), "utf8");
  } catch (_) {}
  try {
    return fs.readFileSync(path.join(__dirname, "embedded-index.html"), "utf8");
  } catch (_) {}
  try {
    return require("./embedded-index.js");
  } catch (_) {}
  return null;
}

app.get("/", (_req, res) => {
  const html = loadAdminIndexHtml();
  if (html) {
    return res.type("html").send(html);
  }
  return res.status(200).type("html").send(`<!DOCTYPE html><html lang="ja"><meta charset="utf-8">
<title>エラー</title><body style="font-family:sans-serif;padding:1.5rem">
<p>管理画面を読み込めません。<code>embedded-index.html</code> または <code>embedded-index.js</code> をリポジトリの<strong>一番上のフォルダ</strong>に置いてください。</p>
</body></html>`);
});

app.use(express.static(PUBLIC_DIR));

app.use((req, res) => {
  if (req.path.startsWith("/api/")) {
    return res.status(404).json({ ok: false });
  }
  res.status(404).type("text/plain").send("not-found-qr-magic-v7");
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
