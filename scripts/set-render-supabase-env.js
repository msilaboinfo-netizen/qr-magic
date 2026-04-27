/**
 * Render の Web サービスに SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY を API で設定する。
 *
 * 次のどちらか:
 *   A) .env に RENDER_* / SUPABASE_* を書く → node scripts/set-render-supabase-env.js
 *   B) メモ帳で secrets-for-render.txt を編集（黒い画面に貼らない）→ 同じコマンド
 *      ファイルは qr-magic フォルダの直下。例は secrets-for-render.example.txt
 */
const fs = require("fs");
const path = require("path");
const https = require("https");

function loadSecretsFromFile() {
  const p = process.env.RENDER_SECRETS_FILE || path.join(__dirname, "..", "secrets-for-render.txt");
  if (!fs.existsSync(p)) return;
  const raw = fs.readFileSync(p, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 1) continue;
    const k = t.slice(0, eq).trim();
    const v = t.slice(eq + 1).trim();
    if (!k) continue;
    process.env[k] = v;
  }
  console.log("設定ファイルを読みました:", p);
}

require("dotenv").config();
loadSecretsFromFile();

function reqJson(method, path, bodyObj) {
  const body = bodyObj == null ? "" : JSON.stringify(bodyObj);
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: "api.render.com",
      port: 443,
      method,
      path,
      headers: {
        Authorization: `Bearer ${process.env.RENDER_API_KEY.trim()}`,
        Accept: "application/json",
        "Content-Type": "application/json",
        ...(body ? { "Content-Length": Buffer.byteLength(body, "utf8") } : {}),
      },
    };
    const req = https.request(opts, (res) => {
      let chunks = "";
      res.on("data", (c) => (chunks += c));
      res.on("end", () => {
        let parsed = null;
        try {
          parsed = chunks ? JSON.parse(chunks) : null;
        } catch (_) {}
        resolve({ status: res.statusCode, raw: chunks, json: parsed });
      });
    });
    req.on("error", reject);
    if (body) req.write(body, "utf8");
    req.end();
  });
}

async function putEnvVar(serviceId, key, value) {
  const path = `/v1/services/${encodeURIComponent(serviceId)}/env-vars/${encodeURIComponent(key)}`;
  const res = await reqJson("PUT", path, { value });
  if (res.status < 200 || res.status >= 300) {
    const msg = (res.json && res.json.message) || res.raw || res.status;
    throw new Error(`${key}: HTTP ${res.status} ${msg}`);
  }
  console.log(`OK: ${key}`);
}

async function main() {
  const RENDER_API_KEY = (process.env.RENDER_API_KEY || "").trim();
  const SERVICE_ID = (process.env.RENDER_SERVICE_ID || "").trim();
  let SUPABASE_URL = (process.env.SUPABASE_URL || "").trim();
  const SUPABASE_SERVICE_ROLE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();

  if (!RENDER_API_KEY || !SERVICE_ID) {
    console.error("RENDER_API_KEY または RENDER_SERVICE_ID がありません。");
    console.error(".env に書くか、secrets-for-render.txt をメモ帳で作ってください（例: secrets-for-render.example.txt をコピー）。");
    console.error("");
    console.error("RENDER_API_KEY: Render → Account Settings → API Keys");
    console.error("RENDER_SERVICE_ID: サービス URL の srv-xxxx");
    process.exit(1);
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error("SUPABASE_URL または SUPABASE_SERVICE_ROLE_KEY がありません。");
    console.error(".env か secrets-for-render.txt に書いてください。");
    process.exit(1);
  }

  SUPABASE_URL = SUPABASE_URL.replace(/\/+$/, "");
  if (/\/rest\/v1\/?$/i.test(SUPABASE_URL)) {
    SUPABASE_URL = SUPABASE_URL.replace(/\/rest\/v1\/?$/i, "");
    console.log("Note: removed /rest/v1/ from SUPABASE_URL (base URL only).");
  }

  await putEnvVar(SERVICE_ID, "SUPABASE_URL", SUPABASE_URL);
  await putEnvVar(SERVICE_ID, "SUPABASE_SERVICE_ROLE_KEY", SUPABASE_SERVICE_ROLE_KEY);

  console.log("");
  console.log("Render に 2 本の環境変数を設定しました。ダッシュボードで再デプロイが走るか確認してください。");
  console.log("手元からデプロイだけ叩く: npm run deploy（.env に RENDER_DEPLOY_HOOK がある場合）");
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
