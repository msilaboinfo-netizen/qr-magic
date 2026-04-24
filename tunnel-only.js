/**
 * 無料トンネル（localtunnel）で 3333 を公開し、URL を data/tunnel-url.txt に書きます。
 * npm run public で server.js と一緒に起動されます。cloudflared は不要です。
 */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const localtunnel = require("localtunnel");

const PORT = Number(process.env.PORT || 3333);
const DATA_DIR = path.join(__dirname, "data");

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

(async () => {
  await sleep(3000);

  let tunnel;
  try {
    tunnel = await localtunnel({ port: PORT });
  } catch (e) {
    console.error("[tunnel] 接続に失敗しました:", e.message || e);
    process.exit(1);
  }

  let url = tunnel.url || "";
  if (url.startsWith("http://")) {
    url = "https://" + url.slice("http://".length);
  }
  url = url.replace(/\/+$/, "");

  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const f = path.join(DATA_DIR, "tunnel-url.txt");
  fs.writeFileSync(f, `${url}\n`, "utf8");

  console.log("");
  console.log("------------------------------------------------------------");
  console.log(" インターネット用のURL（観客のスマホから開けます）");
  console.log("");
  console.log("   ", url);
  console.log("");
  console.log(" 管理画面の「観客用QR」は数秒以内に自動で切り替わります。");
  console.log(" （切り替わらなければ F5 で再読み込み）");
  console.log("------------------------------------------------------------");
  console.log("");

  tunnel.on("close", () => {
    console.log("[tunnel] トンネルが閉じました。");
    try {
      fs.unlinkSync(f);
    } catch (_) {}
  });
})();
