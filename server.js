/**
 * Personal QR: name-card URLs bind on first scan; login is 8-digit ID.
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
const https = require("https");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const QRCode = require("qrcode");
const JSZip = require("jszip");

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
const PUBLIC_TOKEN = process.env.PUBLIC_TOKEN || "dev-public-change-me";
const ADMIN_ID = "19940131";
const YOUTUBE_API_KEY = (process.env.YOUTUBE_API_KEY || "").trim();

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
  const ytTop = "{host}/yt-top?q={query}";
  return {
    queries: [""],
    /** プルダウン用。実際のリダイレクトは activeTemplateIndex の template（serviceTemplate と同期） */
    templatePresets: [
      { label: "Google", template: google },
      { label: "Google マップ", template: maps },
      { label: "YouTube 即再生(近似)", template: ytTop },
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
    /** 簡易アクセス履歴（最新が後ろ） */
    scanEvents: [],
    /** ログイン用ID一覧（8桁数字） */
    loginCodes: {
      [ADMIN_ID]: { role: "admin", active: true, createdAt: new Date().toISOString() },
    },
    /** セッション（token -> {id,role,createdAt}） */
    sessions: {},
  };
}

const MAX_TEMPLATE_PRESETS = 20;
const MAX_SCAN_EVENTS = 1000;

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
  const hasYouTubeTop = merged.templatePresets.some((p) => String(p.template || "").includes("/yt-top?q={query}"));
  if (!hasYouTubeTop && merged.templatePresets.length < MAX_TEMPLATE_PRESETS) {
    merged.templatePresets.push({ label: "YouTube 即再生(近似)", template: "{host}/yt-top?q={query}" });
  }
  syncTemplatesFromPresets(merged);
}

function normalizeTicketKeywordMode(s) {
  s.ticketKeywordMode = s.ticketKeywordMode === "recycle" ? "recycle" : "frozen";
}

function normalizeLoginCodesOnRead(merged) {
  const raw = merged.loginCodes && typeof merged.loginCodes === "object" ? merged.loginCodes : {};
  const out = {};
  for (const k of Object.keys(raw)) {
    const id = String(k || "").trim();
    if (!/^\d{8}$/.test(id)) continue;
    const v = raw[k] && typeof raw[k] === "object" ? raw[k] : {};
    const role = id === ADMIN_ID ? "admin" : "user";
    out[id] = {
      role,
      active: v.active !== false,
      createdAt: typeof v.createdAt === "string" && v.createdAt ? v.createdAt : null,
      revokedAt: typeof v.revokedAt === "string" && v.revokedAt ? v.revokedAt : null,
    };
  }
  if (!out[ADMIN_ID]) {
    out[ADMIN_ID] = { role: "admin", active: true, createdAt: new Date().toISOString(), revokedAt: null };
  } else {
    out[ADMIN_ID].role = "admin";
    out[ADMIN_ID].active = true;
    out[ADMIN_ID].revokedAt = null;
  }
  merged.loginCodes = out;
}

function normalizeSessionsOnRead(merged) {
  const raw = merged.sessions && typeof merged.sessions === "object" ? merged.sessions : {};
  const out = {};
  for (const tok of Object.keys(raw)) {
    const s = raw[tok];
    if (!tok || !s || typeof s !== "object") continue;
    const id = String(s.id || "").trim();
    const role = s.role === "admin" ? "admin" : "user";
    if (!/^\d{8}$/.test(id)) continue;
    out[tok] = {
      id,
      role,
      createdAt: typeof s.createdAt === "string" && s.createdAt ? s.createdAt : null,
    };
  }
  merged.sessions = out;
}

function normalizeTicketOwnersOnRead(merged) {
  const tickets = merged.tickets && typeof merged.tickets === "object" ? merged.tickets : {};
  for (const tok of Object.keys(tickets)) {
    const t = tickets[tok];
    if (!t || typeof t !== "object") continue;
    const owner = String(t.ownerId || "").trim();
    t.ownerId = /^\d{8}$/.test(owner) ? owner : ADMIN_ID;
  }
}

function normalizeScanEventsOnRead(merged) {
  const arr = Array.isArray(merged.scanEvents) ? merged.scanEvents : [];
  merged.scanEvents = arr
    .filter((e) => e && typeof e === "object")
    .map((e) => ({
      at: typeof e.at === "string" && e.at ? e.at : null,
      token: typeof e.token === "string" ? e.token : "",
      path: typeof e.path === "string" ? e.path : "",
      query: typeof e.query === "string" ? e.query : "",
      ownerId: /^\d{8}$/.test(String(e.ownerId || "").trim()) ? String(e.ownerId).trim() : ADMIN_ID,
    }))
    .filter((e) => e.at && e.token && e.path)
    .slice(-MAX_SCAN_EVENTS);
}

function ensureTicketStats(ticket) {
  const t = ticket && typeof ticket === "object" ? ticket : {};
  const c = Number(t.hitCount);
  t.hitCount = Number.isFinite(c) && c >= 0 ? Math.floor(c) : 0;
  t.createdAt = typeof t.createdAt === "string" && t.createdAt ? t.createdAt : null;
  t.lastHitAt = typeof t.lastHitAt === "string" && t.lastHitAt ? t.lastHitAt : null;
  t.ownerId = /^\d{8}$/.test(String(t.ownerId || "").trim()) ? String(t.ownerId).trim() : ADMIN_ID;
  return t;
}

function appendScanEvent(state, event) {
  if (!Array.isArray(state.scanEvents)) state.scanEvents = [];
  state.scanEvents.push(event);
  if (state.scanEvents.length > MAX_SCAN_EVENTS) {
    state.scanEvents = state.scanEvents.slice(-MAX_SCAN_EVENTS);
  }
}

function countOwnedTickets(state, actor) {
  const tickets = state.tickets && typeof state.tickets === "object" ? state.tickets : {};
  return Object.keys(tickets).filter((tok) => {
    if (isAdminActor(actor)) return true;
    const t = tickets[tok];
    return t && String(t.ownerId || "") === actor.id;
  }).length;
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
  normalizeTicketOwnersOnRead(merged);
  normalizeScanEventsOnRead(merged);
  normalizeLoginCodesOnRead(merged);
  normalizeSessionsOnRead(merged);
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

function bearerToken(req) {
  const auth = req.headers.authorization || "";
  if (!auth.startsWith("Bearer ")) return "";
  return auth.slice("Bearer ".length).trim();
}

function isAdminActor(actor) {
  return actor && actor.role === "admin";
}

function issueSessionToken() {
  return crypto.randomBytes(24).toString("hex");
}

function generateUserLoginId(state) {
  if (!state.loginCodes || typeof state.loginCodes !== "object") state.loginCodes = {};
  let id = "";
  let guard = 0;
  do {
    id = String(Math.floor(10000000 + Math.random() * 90000000));
    guard++;
  } while ((id === ADMIN_ID || state.loginCodes[id]) && guard < 200);
  if (!/^\d{8}$/.test(id) || state.loginCodes[id]) {
    throw new Error("ID generation failed");
  }
  return id;
}

function authRequired(req, res, next) {
  const token = bearerToken(req);
  if (!token) return res.status(401).json({ ok: false, message: "Unauthorized" });
  readState()
    .then((state) => {
      const session = state.sessions && state.sessions[token];
      if (!session) return res.status(401).json({ ok: false, message: "Unauthorized" });
      const code = state.loginCodes && state.loginCodes[session.id];
      if (!code || code.active === false) return res.status(401).json({ ok: false, message: "Unauthorized" });
      req.auth = {
        token,
        id: session.id,
        role: session.role === "admin" ? "admin" : "user",
      };
      req.authState = state;
      return next();
    })
    .catch((e) => {
      console.error(e);
      res.status(500).json({ ok: false, message: "状態の読み込みに失敗しました" });
    });
}

function adminOnly(req, res, next) {
  if (!isAdminActor(req.auth)) return res.status(403).json({ ok: false, message: "forbidden" });
  next();
}

function buildUrl(template, query, req) {
  const host = `${req.protocol}://${req.get("host")}`;
  return template
    .replaceAll("{host}", host)
    .replaceAll("{query}", encodeURIComponent(query));
}

function getAudienceBaseUrl(req) {
  return getPublicBaseUrl() || `${req.protocol}://${req.get("host")}`;
}

function httpsGetJson(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return reject(new Error(`HTTP ${res.statusCode}`));
          }
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(e);
          }
        });
      })
      .on("error", reject);
  });
}

function youtubeSearchFallbackUrl(query) {
  return `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
}

async function pickTopViewedYouTubeVideoId(query) {
  if (!YOUTUBE_API_KEY) return null;
  const q = String(query || "").trim();
  if (!q) return null;
  const searchUrl =
    "https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=10" +
    `&q=${encodeURIComponent(q)}` +
    `&key=${encodeURIComponent(YOUTUBE_API_KEY)}`;
  const search = await httpsGetJson(searchUrl);
  const ids = (search.items || [])
    .map((it) => (it && it.id && it.id.videoId ? String(it.id.videoId) : ""))
    .filter(Boolean);
  if (!ids.length) return null;
  const videosUrl =
    "https://www.googleapis.com/youtube/v3/videos?part=statistics&id=" +
    encodeURIComponent(ids.join(",")) +
    `&key=${encodeURIComponent(YOUTUBE_API_KEY)}`;
  const videos = await httpsGetJson(videosUrl);
  let bestId = null;
  let bestViews = -1;
  for (const v of videos.items || []) {
    const id = String(v && v.id ? v.id : "");
    const views = Number(v && v.statistics && v.statistics.viewCount ? v.statistics.viewCount : 0);
    if (!id) continue;
    if (views > bestViews) {
      bestViews = views;
      bestId = id;
    }
  }
  return bestId;
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
      out[key] = ensureTicketStats({ query: q.length ? q : null, template: null, ownerId: ADMIN_ID });
      continue;
    }
    if (typeof v === "object") {
      out[key] = ensureTicketStats({
        query: v.query == null || String(v.query).trim() === "" ? null : v.query,
        template: v.template == null ? null : v.template,
        hitCount: v.hitCount,
        createdAt: v.createdAt,
        lastHitAt: v.lastHitAt,
        ownerId: /^\d{8}$/.test(String(v.ownerId || "").trim()) ? String(v.ownerId).trim() : ADMIN_ID,
      });
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

/** 曲名などを受け取り、YouTubeの再生数上位動画へ直接リダイレクト（APIキー未設定時は検索結果へ） */
app.get("/yt-top", async (req, res) => {
  const q = String((req.query && req.query.q) || "").trim();
  if (!q) return res.redirect(302, "https://www.youtube.com/");
  try {
    const bestId = await pickTopViewedYouTubeVideoId(q);
    if (bestId) {
      return res.redirect(302, `https://www.youtube.com/watch?v=${encodeURIComponent(bestId)}`);
    }
  } catch (e) {
    console.error("[yt-top]", e && e.message ? e.message : e);
  }
  return res.redirect(302, youtubeSearchFallbackUrl(q));
});

/** IDログイン（8桁）。管理者ID=19940131 */
app.post("/api/login", async (req, res) => {
  const id = String((req.body && req.body.id) || "").trim();
  if (!/^\d{8}$/.test(id)) {
    return res.status(400).json({ ok: false, message: "IDは8桁の数字です" });
  }
  let state;
  try {
    state = await readState();
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, message: "状態の読み込みに失敗しました" });
  }
  const code = state.loginCodes && state.loginCodes[id];
  if (!code || code.active === false) {
    return res.status(401).json({ ok: false, message: "IDが無効です" });
  }
  const role = id === ADMIN_ID ? "admin" : "user";
  if (!state.sessions || typeof state.sessions !== "object") state.sessions = {};
  if (role !== "admin") {
    for (const tok of Object.keys(state.sessions)) {
      if (state.sessions[tok] && state.sessions[tok].id === id) delete state.sessions[tok];
    }
  }
  const token = issueSessionToken();
  state.sessions[token] = {
    id,
    role,
    createdAt: new Date().toISOString(),
  };
  try {
    await writeState(state);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, message: "ログイン保存に失敗しました" });
  }
  return res.json({
    ok: true,
    token,
    actor: { id, role },
  });
});

app.post("/api/logout", authRequired, async (req, res) => {
  const state = req.authState || (await readState());
  if (state.sessions && typeof state.sessions === "object") {
    delete state.sessions[req.auth.token];
  }
  try {
    await writeState(state);
  } catch (e) {
    console.error(e);
  }
  res.json({ ok: true });
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
    let chosenQuery = null;

    if (ticketQueryBound(t)) {
      chosenQuery = String(t.query || "").trim();
    } else if (recycle) {
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
      chosenQuery = live;
    } else {
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
      chosenQuery = live;
      state.tickets[ticketKey].query = live;
    }
    const now = new Date().toISOString();
    const activeTicket = ensureTicketStats(state.tickets[ticketKey] || {});
    activeTicket.hitCount += 1;
    activeTicket.lastHitAt = now;
    if (!activeTicket.createdAt) activeTicket.createdAt = now;
    state.tickets[ticketKey] = activeTicket;
    appendScanEvent(state, {
      at: now,
      token: ticketKey,
      path: `/r/${ticketKey}`,
      query: String(chosenQuery || ""),
      ownerId: activeTicket.ownerId || ADMIN_ID,
    });
    try {
      await writeState(state);
    } catch (e) {
      console.error(e);
      return res.status(500).type("text/plain").send("Server error");
    }
    const url = buildUrl(tmpl, chosenQuery, req);
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
app.get("/api/state", authRequired, async (req, res) => {
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
    actor: req.auth,
    state: {
      queries: state.queries,
      serviceTemplate: state.serviceTemplate,
      templatePresets: state.templatePresets,
      activeTemplateIndex: state.activeTemplateIndex,
      ticketKeywordMode: state.ticketKeywordMode,
      ticketCount: countOwnedTickets(state, req.auth),
    },
  });
});

app.put("/api/state", authRequired, async (req, res) => {
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
    state: { ...next, ticketCount: countOwnedTickets(next, req.auth) },
  });
});

/** 管理者用: ログインID一覧 */
app.get("/api/admin/codes", authRequired, adminOnly, async (req, res) => {
  let state;
  try {
    state = await readState();
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, message: "状態の読み込みに失敗しました" });
  }
  const rows = Object.keys(state.loginCodes || {})
    .sort()
    .map((id) => ({
      id,
      role: id === ADMIN_ID ? "admin" : "user",
      active: state.loginCodes[id].active !== false,
      createdAt: state.loginCodes[id].createdAt || null,
      revokedAt: state.loginCodes[id].revokedAt || null,
    }));
  res.json({ ok: true, codes: rows });
});

/** 管理者用: ユーザーIDを一括発行 */
app.post("/api/admin/codes/bulk", authRequired, adminOnly, async (req, res) => {
  const raw = parseInt(req.body && req.body.count, 10);
  const count = Math.min(5000, Math.max(1, Number.isFinite(raw) ? raw : 0));
  if (!count) return res.status(400).json({ ok: false, message: "count は 1〜5000" });
  let state;
  try {
    state = await readState();
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, message: "状態の読み込みに失敗しました" });
  }
  if (!state.loginCodes || typeof state.loginCodes !== "object") state.loginCodes = {};
  const created = [];
  for (let i = 0; i < count; i++) {
    const id = generateUserLoginId(state);
    state.loginCodes[id] = {
      role: "user",
      active: true,
      createdAt: new Date().toISOString(),
      revokedAt: null,
    };
    created.push(id);
  }
  try {
    await writeState(state);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, message: "保存に失敗しました" });
  }
  res.json({ ok: true, ids: created, total: Object.keys(state.loginCodes || {}).length });
});

/** 管理者用: IDを即時無効化 */
app.post("/api/admin/codes/revoke", authRequired, adminOnly, async (req, res) => {
  const id = String((req.body && req.body.id) || "").trim();
  if (!/^\d{8}$/.test(id) || id === ADMIN_ID) {
    return res.status(400).json({ ok: false, message: "無効化できないIDです" });
  }
  let state;
  try {
    state = await readState();
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, message: "状態の読み込みに失敗しました" });
  }
  if (!state.loginCodes || !state.loginCodes[id]) {
    return res.status(404).json({ ok: false, message: "IDが見つかりません" });
  }
  state.loginCodes[id].active = false;
  state.loginCodes[id].revokedAt = new Date().toISOString();
  if (state.sessions && typeof state.sessions === "object") {
    for (const tok of Object.keys(state.sessions)) {
      if (state.sessions[tok] && state.sessions[tok].id === id) delete state.sessions[tok];
    }
  }
  try {
    await writeState(state);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, message: "保存に失敗しました" });
  }
  res.json({ ok: true });
});

/** 登録中の名刺用パス一覧（管理画面の設定メニュー用） */
app.get("/api/tickets", authRequired, async (req, res) => {
  let state;
  try {
    state = await readState();
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, message: "状態の読み込みに失敗しました" });
  }
  const tickets =
    state.tickets && typeof state.tickets === "object" && !Array.isArray(state.tickets) ? state.tickets : {};
  const actorId = req.auth.id;
  const keysAll = Object.keys(tickets)
    .filter((tok) => isAdminActor(req.auth) || String(tickets[tok].ownerId || "") === actorId)
    .sort();
  /** 永久化でキーワード固定済みの名刺は「未印刷用一覧」から除外 */
  const keys = keysAll.filter((tok) => !ticketQueryBound(ensureTicketStats(tickets[tok] || {})));
  const paths = keys.map((tok) => `/r/${tok}`);
  const rows = keys.map((tok) => {
    const t = ensureTicketStats(tickets[tok] || {});
    return {
      token: tok,
      path: `/r/${tok}`,
      hitCount: t.hitCount,
      createdAt: t.createdAt,
      lastHitAt: t.lastHitAt,
      queryBound: ticketQueryBound(t),
      query: t.query == null ? null : String(t.query),
    };
  });
  res.json({
    ok: true,
    ticketCount: keysAll.length,
    listCount: paths.length,
    paths,
    tickets: rows,
  });
});

/** 設定ドロワー向け: 簡易アクセス履歴（合計・各URL・直近イベント） */
app.get("/api/tickets/history", authRequired, async (req, res) => {
  let state;
  try {
    state = await readState();
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, message: "状態の読み込みに失敗しました" });
  }
  const tickets =
    state.tickets && typeof state.tickets === "object" && !Array.isArray(state.tickets) ? state.tickets : {};
  const actorId = req.auth.id;
  const keys = Object.keys(tickets)
    .filter((tok) => isAdminActor(req.auth) || String(tickets[tok].ownerId || "") === actorId)
    .sort();
  const rows = keys.map((tok) => {
    const t = ensureTicketStats(tickets[tok] || {});
    return {
      token: tok,
      path: `/r/${tok}`,
      hitCount: t.hitCount,
      createdAt: t.createdAt,
      lastHitAt: t.lastHitAt,
      queryBound: ticketQueryBound(t),
      query: t.query == null ? null : String(t.query),
    };
  });
  rows.sort((a, b) => b.hitCount - a.hitCount || a.path.localeCompare(b.path));
  const totalHits = rows.reduce((sum, r) => sum + r.hitCount, 0);
  const events = (Array.isArray(state.scanEvents) ? state.scanEvents : [])
    .filter((e) => isAdminActor(req.auth) || String(e.ownerId || "") === actorId)
    .slice(-200)
    .reverse();
  res.json({
    ok: true,
    ticketCount: rows.length,
    totalHits,
    tickets: rows,
    recentEvents: events,
  });
});

/** 設定ドロワー向け: 発行済みQRを PNG でまとめて ZIP ダウンロード */
app.get("/api/tickets/qr-zip", authRequired, async (req, res) => {
  let state;
  try {
    state = await readState();
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, message: "状態の読み込みに失敗しました" });
  }
  const tickets =
    state.tickets && typeof state.tickets === "object" && !Array.isArray(state.tickets) ? state.tickets : {};
  const actorId = req.auth.id;
  const keys = Object.keys(tickets)
    .filter((tok) => isAdminActor(req.auth) || String(tickets[tok].ownerId || "") === actorId)
    .sort();
  if (keys.length === 0) {
    return res.status(400).json({ ok: false, message: "名刺用URLがありません" });
  }
  const base = String(getAudienceBaseUrl(req)).replace(/\/+$/, "");
  try {
    const zip = new JSZip();
    const lines = [];
    for (let i = 0; i < keys.length; i++) {
      const tok = keys[i];
      const pathPart = `/r/${tok}`;
      const fullUrl = `${base}${pathPart}`;
      lines.push(fullUrl);
      const png = await QRCode.toBuffer(fullUrl, {
        type: "png",
        width: 512,
        margin: 1,
        errorCorrectionLevel: "M",
      });
      const fileName = `${String(i + 1).padStart(4, "0")}_${tok}.png`;
      zip.file(`qrs/${fileName}`, png);
    }
    zip.file("ticket-urls.txt", lines.join("\n"));
    const zipBuf = await zip.generateAsync({
      type: "nodebuffer",
      compression: "DEFLATE",
      compressionOptions: { level: 6 },
    });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename=\"qr-tickets-${stamp}.zip\"`);
    return res.status(200).send(zipBuf);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, message: "ZIP生成に失敗しました" });
  }
});

/** 名刺用URLを count 枚ぶん発行（単語は未割当。frozen なら初回で固定、recycle なら常に現在キーワード） */
app.post("/api/tickets/bulk", authRequired, async (req, res) => {
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
    cur.tickets[tok] = ensureTicketStats({
      query: null,
      template: null,
      createdAt: new Date().toISOString(),
      hitCount: 0,
      lastHitAt: null,
      ownerId: req.auth.id,
    });
    created.push({ token: tok, path: `/r/${tok}` });
  }
  try {
    await writeState(cur);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, message: "保存に失敗しました（Supabase を確認）" });
  }
  res.json({ ok: true, tickets: created, ticketCount: countOwnedTickets(cur, req.auth) });
});

/** 名刺用URLをすべて削除（確認用に body.confirm が true） */
app.post("/api/tickets/clear", authRequired, async (req, res) => {
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
  if (isAdminActor(req.auth)) {
    cur.tickets = {};
    cur.scanEvents = [];
  } else {
    const own = req.auth.id;
    const nextTickets = {};
    for (const tok of Object.keys(cur.tickets || {})) {
      const t = cur.tickets[tok];
      if (!t || typeof t !== "object") continue;
      if (String(t.ownerId || "") !== own) nextTickets[tok] = t;
    }
    cur.tickets = nextTickets;
    cur.scanEvents = (Array.isArray(cur.scanEvents) ? cur.scanEvents : []).filter((e) => String(e.ownerId || "") !== own);
  }
  try {
    await writeState(cur);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, message: "保存に失敗しました（Supabase を確認）" });
  }
  const remain = Object.keys(cur.tickets || {}).filter((tok) => {
    const t = cur.tickets[tok];
    return isAdminActor(req.auth) || String((t && t.ownerId) || "") === req.auth.id;
  }).length;
  res.json({ ok: true, ticketCount: remain });
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
  console.log(`Login: open http://localhost:${PORT}/  (8桁ID / 管理者ID=${ADMIN_ID})`);
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
