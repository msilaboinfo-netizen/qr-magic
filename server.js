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

/** Render 等のエフェメラルディスクでは消える。設定すると名刺URLもデプロイ後も残る */
const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim();
const SUPABASE_SERVICE_ROLE_KEY = (
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SECRET_KEY ||
  ""
).trim();
const QR_MAGIC_STATE_TABLE = "qr_magic_app_state";

let supabaseClient = null;
function getSupabase() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return null;
  if (!supabaseClient) {
    const { createClient } = require("@supabase/supabase-js");
    supabaseClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return supabaseClient;
}

const PORT = Number(process.env.PORT || 3333);
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "dev-admin-change-me";
const PUBLIC_TOKEN = process.env.PUBLIC_TOKEN || "dev-public-change-me";

const DATA_DIR = path.join(__dirname, "data");
const STATE_FILE = path.join(DATA_DIR, "state.json");
const TUNNEL_URL_FILE = path.join(DATA_DIR, "tunnel-url.txt");
const PACKAGE_JSON = path.join(__dirname, "package.json");

/** 管理画面表示用。仕様やUIを変えたら package.json の version を上げる */
function getAppVersion() {
  try {
    return JSON.parse(fs.readFileSync(PACKAGE_JSON, "utf8")).version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

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

/** Google Maps 公式の検索用 URL（api=1 と query が必要） */
const MAPS_SEARCH_TEMPLATE = "https://www.google.com/maps/search/?api=1&query={query}";

function defaultState() {
  const google = "https://www.google.com/search?q={query}";
  const maps = MAPS_SEARCH_TEMPLATE;
  return {
    queries: [""],
    /** プルダウン用。実際のリダイレクトは activeTemplateIndex の template（serviceTemplate と同期） */
    templatePresets: [
      { label: "Google", template: google },
      { label: "Google マップ", template: maps },
    ],
    activeTemplateIndex: 0,
    /** 互換・内部同期用（= templatePresets[activeTemplateIndex].template） */
    serviceTemplate: google,
    /**
     * 名刺用: トークン → { query, template }
     * query が null/空のときは「未割当」→ 初回GETでその時点のキーワード（queries の先頭の非空）を保存して固定
     * template が null のときは常に state.serviceTemplate を使う（将来の変更に追従）
     */
    /** 名刺用キーワード: frozen=初回で固定 / recycle=常に管理画面のキーワードに追従 */
    ticketKeywordMode: "frozen",
    tickets: {},
  };
}

const MAX_TEMPLATE_PRESETS = 20;

function syncTemplatesFromPresets(state) {
  const presets = Array.isArray(state.templatePresets) ? state.templatePresets : [];
  const cleaned = [];
  for (const p of presets) {
    const label = String((p && p.label) || "").trim().slice(0, 60) || `プリセット ${cleaned.length + 1}`;
    const tmpl = String((p && p.template) || "").trim();
    if (!tmpl.includes("{query}")) continue;
    cleaned.push({ label, template: tmpl });
  }
  if (cleaned.length === 0) {
    const fb = defaultState().serviceTemplate;
    cleaned.push({ label: "Google", template: fb });
  }
  let idx = parseInt(state.activeTemplateIndex, 10);
  if (!Number.isFinite(idx) || idx < 0 || idx >= cleaned.length) idx = 0;
  state.templatePresets = cleaned;
  state.activeTemplateIndex = idx;
  state.serviceTemplate = cleaned[idx].template;
}

function migrateTemplatePresets(merged) {
  const base = defaultState();
  const legacy = String(merged.serviceTemplate || "").trim();
  if (!Array.isArray(merged.templatePresets) || merged.templatePresets.length === 0) {
    merged.templatePresets = legacy.includes("{query}")
      ? [{ label: "既定", template: legacy }]
      : [{ ...base.templatePresets[0] }];
  }
  merged.templatePresets = (merged.templatePresets || []).map((p) => {
    const t = String((p && p.template) || "");
    if (t === "https://www.google.com/maps/search?q={query}") {
      return { ...p, template: MAPS_SEARCH_TEMPLATE };
    }
    return { ...p };
  });
  const hasMaps = merged.templatePresets.some((p) => String(p.template || "").includes("google.com/maps"));
  if (!hasMaps && merged.templatePresets.length < MAX_TEMPLATE_PRESETS) {
    merged.templatePresets.push({ label: "Google マップ", template: MAPS_SEARCH_TEMPLATE });
  }
  syncTemplatesFromPresets(merged);
}

function normalizeTicketKeywordMode(s) {
  s.ticketKeywordMode = s.ticketKeywordMode === "recycle" ? "recycle" : "frozen";
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

function hydrateMergedState(parsed) {
  const merged = { ...defaultState(), ...(parsed && typeof parsed === "object" ? parsed : {}) };
  merged.queries = normalizeQueriesToSingle(merged.queries);
  normalizeTicketsOnRead(merged);
  migrateTemplatePresets(merged);
  normalizeTicketKeywordMode(merged);
  return merged;
}

function readStateFromFileSync() {
  ensureDataDir();
  if (!fs.existsSync(STATE_FILE)) {
    const s = hydrateMergedState({});
    writeStateToFileSync(s);
    return s;
  }
  try {
    const raw = fs.readFileSync(STATE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return hydrateMergedState(parsed);
  } catch {
    return hydrateMergedState({});
  }
}

async function readStateFromSupabase() {
  const sb = getSupabase();
  const { data, error } = await sb.from(QR_MAGIC_STATE_TABLE).select("data").eq("id", 1).maybeSingle();
  if (error) {
    console.error("[qr-magic] Supabase readState:", error.message);
    return hydrateMergedState({});
  }
  if (data && data.data != null && typeof data.data === "object") {
    return hydrateMergedState(data.data);
  }
  if (fs.existsSync(STATE_FILE)) {
    try {
      const raw = fs.readFileSync(STATE_FILE, "utf8");
      const parsed = JSON.parse(raw);
      const merged = hydrateMergedState(parsed);
      await writeStateToSupabase(merged);
      return merged;
    } catch (_) {}
  }
  return hydrateMergedState({});
}

/** 旧「パフォーマンス／永続化」用フィールド。もう使わないので保存時に落とす */
function stripLegacyPerformanceFlags(s) {
  if (!s || typeof s !== "object") return;
  delete s.counter;
  delete s.performanceActive;
  delete s.permanent;
}

function writeStateToFileSync(state) {
  ensureDataDir();
  stripLegacyPerformanceFlags(state);
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
}

async function writeStateToSupabase(state) {
  const sb = getSupabase();
  stripLegacyPerformanceFlags(state);
  const row = {
    id: 1,
    data: state,
    updated_at: new Date().toISOString(),
  };
  const { error } = await sb.from(QR_MAGIC_STATE_TABLE).upsert(row, { onConflict: "id" });
  if (error) {
    console.error("[qr-magic] Supabase writeState:", error.message);
    throw error;
  }
}

async function readState() {
  if (getSupabase()) return readStateFromSupabase();
  return readStateFromFileSync();
}

async function writeState(state) {
  if (getSupabase()) {
    await writeStateToSupabase(state);
    return;
  }
  writeStateToFileSync(state);
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

/** state.json の tickets を常に { token: { query, template } } 形にそろえる（旧形式・null 対策） */
function normalizeTicketsOnRead(merged) {
  const raw = merged.tickets;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    merged.tickets = {};
    return;
  }
  const out = {};
  for (const k of Object.keys(raw)) {
    const key = String(k).trim();
    if (!key || key === PUBLIC_TOKEN) continue;
    const v = raw[k];
    if (v == null) continue;
    if (typeof v === "string") {
      const q = v.trim();
      out[key] = { query: q.length ? q : null, template: null };
      continue;
    }
    if (typeof v === "object") {
      out[key] = {
        query: v.query == null || String(v.query).trim() === "" ? null : v.query,
        template: v.template == null ? null : v.template,
      };
    }
  }
  merged.tickets = out;
}

/** QR のパスと state のトークンを突き合わせ（エンコード・大文字小文字の差を吸収） */
function findTicketEntry(state, rawToken) {
  const tickets =
    state.tickets && typeof state.tickets === "object" && !Array.isArray(state.tickets) ? state.tickets : {};
  const t0 = String(rawToken || "").trim();
  if (!t0) return null;
  function pick(key) {
    if (!Object.prototype.hasOwnProperty.call(tickets, key)) return null;
    const ticket = tickets[key];
    if (!ticket || typeof ticket !== "object") return null;
    return { key, ticket };
  }
  const a = pick(t0);
  if (a) return a;
  try {
    const d = decodeURIComponent(t0);
    if (d !== t0) {
      const b = pick(d);
      if (b) return b;
    }
  } catch (_) {}
  const low = t0.toLowerCase();
  for (const k of Object.keys(tickets)) {
    if (k.toLowerCase() === low) {
      const c = pick(k);
      if (c) return c;
    }
  }
  return null;
}

const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "512kb" }));

app.get("/api/version", (_req, res) => {
  res.json({ ok: true, version: getAppVersion() });
});

/** トンネル等で観客用オリジンが決まったら管理画面がポーリングする（URL表示は廃止済み） */
app.get("/api/public-qr-hint", (req, res) => {
  const base = getPublicBaseUrl();
  res.json({ ok: true, publicBaseUrl: base || null });
});

/** Spectator scan */
app.get("/r/:token", async (req, res) => {
  let state;
  try {
    state = await readState();
  } catch (e) {
    console.error(e);
    return res.status(500).type("text/plain").send("Server error");
  }
  const found = findTicketEntry(state, req.params.token);
  /**
   * 名刺用:
   * - 一度でも query が入った URL（永久化で初回表示されたもの）は、モード変更後も常にその単語のまま
   * - query がまだ無い URL だけ: recycle なら毎回いまのキーワード / frozen なら初回で query を保存して固定
   */
  if (found) {
    const { key: ticketKey, ticket: t } = found;
    const recycle = state.ticketKeywordMode === "recycle";
    const tmpl =
      t.template && String(t.template).includes("{query}")
        ? String(t.template)
        : state.serviceTemplate || defaultState().serviceTemplate;

    if (ticketQueryBound(t)) {
      const url = buildUrl(tmpl, String(t.query || "").trim(), req);
      return res.redirect(302, url);
    }

    if (recycle) {
      const live = firstNonEmptyQuery(state);
      if (!live) {
        return res.status(503).type("html").send(`<!DOCTYPE html>
<html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>名刺QR</title></head>
<body style="font-family:sans-serif;padding:1.5rem;line-height:1.6;max-width:28rem">
<p style="font-size:1.1rem;font-weight:bold">キーワードが空です</p>
<p>管理画面でキーワードを入力し <strong>「設定を保存」</strong> してから、もう一度このQRを読み取ってください。</p>
<p style="color:#555;font-size:.9rem">リサイクルでは、まだ永久化で固定されていない名刺URLだけが、保存中のキーワードに追従します。</p>
</body></html>`);
      }
      const url = buildUrl(tmpl, live, req);
      return res.redirect(302, url);
    }

    const live = firstNonEmptyQuery(state);
    if (!live) {
      return res.status(503).type("html").send(`<!DOCTYPE html>
<html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>名刺QR</title></head>
<body style="font-family:sans-serif;padding:1.5rem;line-height:1.6;max-width:28rem">
<p style="font-size:1.1rem;font-weight:bold">まだ単語が入っていません</p>
<p>マジシャン側の管理画面で、キーワードを入力して <strong>「設定を保存」</strong> してから、もう一度このQRを読み取ってください。</p>
<p style="color:#555;font-size:.9rem">永久化では、この初回で単語がこの名刺URLに固定され、あとから変わりません。</p>
</body></html>`);
    }
    state.tickets[ticketKey].query = live;
    try {
      await writeState(state);
    } catch (e) {
      console.error(e);
      return res.status(500).type("text/plain").send("Server error");
    }
    const url = buildUrl(tmpl, live, req);
    return res.redirect(302, url);
  }

  const token = String(req.params.token || "").trim();
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
app.get("/api/state", adminAuth, async (req, res) => {
  let state;
  try {
    state = await readState();
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, message: "状態の読み込みに失敗しました" });
  }
  res.json({
    ok: true,
    publicBaseUrl: getPublicBaseUrl() || null,
    state: {
      queries: state.queries,
      serviceTemplate: state.serviceTemplate,
      templatePresets: state.templatePresets,
      activeTemplateIndex: state.activeTemplateIndex,
      ticketKeywordMode: state.ticketKeywordMode,
      ticketCount: Object.keys(state.tickets || {}).length,
    },
  });
});

app.put("/api/state", adminAuth, async (req, res) => {
  let cur;
  try {
    cur = await readState();
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, message: "状態の読み込みに失敗しました" });
  }
  const body = req.body || {};
  const next = {
    ...cur,
    queries: normalizeQueriesToSingle(
      Array.isArray(body.queries) ? body.queries.map((q) => String(q)) : cur.queries
    ),
  };

  if (Array.isArray(body.templatePresets)) {
    next.templatePresets = body.templatePresets.slice(0, MAX_TEMPLATE_PRESETS).map((p) => ({
      label: String((p && p.label) || "").trim().slice(0, 60),
      template: String((p && p.template) || "").trim(),
    }));
    const idx = parseInt(body.activeTemplateIndex, 10);
    if (Number.isFinite(idx) && idx >= 0 && idx < next.templatePresets.length) {
      next.activeTemplateIndex = idx;
    } else {
      next.activeTemplateIndex = 0;
    }
    syncTemplatesFromPresets(next);
  } else if (body.activeTemplateIndex !== undefined && body.activeTemplateIndex !== null) {
    const idx = parseInt(body.activeTemplateIndex, 10);
    if (Number.isFinite(idx) && Array.isArray(next.templatePresets) && idx >= 0 && idx < next.templatePresets.length) {
      next.activeTemplateIndex = idx;
    }
    syncTemplatesFromPresets(next);
  } else if (typeof body.serviceTemplate === "string" && body.serviceTemplate.includes("{query}")) {
    next.serviceTemplate = body.serviceTemplate;
    const i = Number.isFinite(parseInt(cur.activeTemplateIndex, 10)) ? parseInt(cur.activeTemplateIndex, 10) : 0;
    if (Array.isArray(next.templatePresets) && next.templatePresets[i]) {
      next.templatePresets[i] = { ...next.templatePresets[i], template: body.serviceTemplate };
    } else {
      next.templatePresets = [{ label: "既定", template: body.serviceTemplate }];
      next.activeTemplateIndex = 0;
    }
    syncTemplatesFromPresets(next);
  } else {
    syncTemplatesFromPresets(next);
  }

  if (body.ticketKeywordMode === "recycle" || body.ticketKeywordMode === "frozen") {
    next.ticketKeywordMode = body.ticketKeywordMode;
  } else {
    next.ticketKeywordMode = cur.ticketKeywordMode === "recycle" ? "recycle" : "frozen";
  }
  normalizeTicketKeywordMode(next);

  try {
    await writeState(next);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, message: "保存に失敗しました（Supabase を確認）" });
  }
  res.json({
    ok: true,
    state: { ...next, ticketCount: Object.keys(next.tickets || {}).length },
  });
});

/** 登録中の名刺用パス一覧（管理画面の設定メニュー用） */
app.get("/api/tickets", adminAuth, async (req, res) => {
  let state;
  try {
    state = await readState();
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, message: "状態の読み込みに失敗しました" });
  }
  const tickets =
    state.tickets && typeof state.tickets === "object" && !Array.isArray(state.tickets) ? state.tickets : {};
  const keys = Object.keys(tickets).sort();
  const paths = keys.map((tok) => `/r/${tok}`);
  res.json({ ok: true, ticketCount: paths.length, paths });
});

/** 名刺用URLを count 枚ぶん発行（単語は未割当。frozen なら初回で固定、recycle なら常に現在キーワード） */
app.post("/api/tickets/bulk", adminAuth, async (req, res) => {
  const raw = parseInt(req.body && req.body.count, 10);
  const count = Math.min(5000, Math.max(1, Number.isFinite(raw) ? raw : 0));
  if (!count) {
    return res.status(400).json({ ok: false, message: "count は 1〜5000" });
  }
  let cur;
  try {
    cur = await readState();
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, message: "状態の読み込みに失敗しました" });
  }
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
  try {
    await writeState(cur);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, message: "保存に失敗しました（Supabase を確認）" });
  }
  res.json({ ok: true, tickets: created, ticketCount: Object.keys(cur.tickets).length });
});

/** 名刺用URLをすべて削除（確認用に body.confirm が true） */
app.post("/api/tickets/clear", adminAuth, async (req, res) => {
  if (!(req.body && req.body.confirm === true)) {
    return res.status(400).json({ ok: false, message: "body.confirm true が必要です" });
  }
  let cur;
  try {
    cur = await readState();
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, message: "状態の読み込みに失敗しました" });
  }
  cur.tickets = {};
  try {
    await writeState(cur);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, message: "保存に失敗しました（Supabase を確認）" });
  }
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
  if (getSupabase()) {
    console.log(`状態の保存先: Supabase テーブル ${QR_MAGIC_STATE_TABLE}（デプロイ後も維持）`);
  } else {
    console.log(`状態の保存先: ローカルファイル ${STATE_FILE}（Render 無料ディスクは非永続のため URL は消えます）`);
    console.log(`永続化するには: .env.example の SUPABASE_* を参照`);
  }
  const localPublic = `http://localhost:${PORT}/r/${PUBLIC_TOKEN}`;
  console.log(`Public QR path (local): ${localPublic}`);
  const pub = getPublicBaseUrl();
  if (pub) {
    console.log(`Public QR path (internet): ${pub}/r/${PUBLIC_TOKEN}`);
  } else {
    console.log(`Internet (かんたん): npm.cmd run public`);
  }
});
