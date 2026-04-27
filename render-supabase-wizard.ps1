<#
  Supabase と Render の「意味」を覚えなくてよい版。
  ブラウザでコピーしたものを、このウィザードが聞く順に貼るだけ。
  （秘密はこの PC のターミナルにだけ表示されます。チャットには貼らないでください）
#>
$ErrorActionPreference = "Continue"
$script:ExitCode = 0

try {
  Set-Location -LiteralPath $PSScriptRoot

  Write-Host ""
  Write-Host "========================================"  -ForegroundColor Cyan
  Write-Host " QR-magic: Render に Supabase を載せる "  -ForegroundColor Cyan
  Write-Host "========================================"  -ForegroundColor Cyan
  Write-Host ""
  Write-Host "あなたがやることは「4 つをコピーして、ここに貼る」だけです。" -ForegroundColor Yellow
  Write-Host "（SQL はもう Supabase で実行済みのはず。まだなら先に SQL を流してください）" -ForegroundColor DarkGray
  Write-Host ""

  $node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $node) {
    Write-Host "Node.js が入っていません。インストールしてからもう一度実行してください。" -ForegroundColor Red
    $script:ExitCode = 1
    throw "no-node"
  }

  function Clean-Url([string]$raw) {
    $t = $raw.Trim().TrimEnd("/")
    if ($t -match "(?i)/rest/v1/?$") { $t = $t -replace "(?i)/rest/v1/?$", "" }
    return $t.TrimEnd("/")
  }

  Write-Host "[1/4] Supabase の URL" -ForegroundColor Green
  Write-Host "      Supabase → Project Settings → General で Project ID が見えます。" -ForegroundColor DarkGray
  Write-Host "      または API のページに Project URL と書いてある行をコピー。" -ForegroundColor DarkGray
  Write-Host "      例: https://xxxx.supabase.co  （/rest/v1/ は付けない）" -ForegroundColor DarkGray
  $u = Read-Host "      ここに貼り付けて Enter"
  $u = Clean-Url $u
  if ($u -notmatch "^https://.+\.supabase\.co$") {
    Write-Warning "通常は https://....supabase.co の形です。続けますか？ Ctrl+C で中止。"
  }

  Write-Host ""
  Write-Host "[2/4] Supabase の「秘密の鍵」" -ForegroundColor Green
  Write-Host "      Project Settings → API Keys → Secret keys の Reveal で出る sb_secret_..." -ForegroundColor DarkGray
  Write-Host "      ※ publishable（sb_publishable_）ではありません。" -ForegroundColor DarkGray
  $s = Read-Host "      ここに貼り付けて Enter"

  Write-Host ""
  Write-Host "[3/4] Render の API Key" -ForegroundColor Green
  Write-Host "      dashboard.render.com → 右上の顔アイコン → Account Settings → API Keys → Create API Key" -ForegroundColor DarkGray
  Write-Host "      rnd_ で始まる長い文字列です。" -ForegroundColor DarkGray
  $r = Read-Host "      ここに貼り付けて Enter"

  Write-Host ""
  Write-Host "[4/4] Render の Service ID" -ForegroundColor Green
  Write-Host "      Render で qr-magic のサービスを開いたとき、アドレスバーに srv-xxxx が出ます。" -ForegroundColor DarkGray
  Write-Host "      その srv- から始まる部分だけをコピー。" -ForegroundColor DarkGray
  $id = Read-Host "      ここに貼り付けて Enter"
  $id = $id.Trim()
  if ($id -notmatch "^srv-") {
    Write-Warning "通常は srv- で始まります。間違いなら Ctrl+C で中止してください。"
  }

  $env:SUPABASE_URL = $u.Trim()
  $env:SUPABASE_SERVICE_ROLE_KEY = $s.Trim()
  $env:RENDER_API_KEY = $r.Trim()
  $env:RENDER_SERVICE_ID = $id.Trim()

  Write-Host ""
  Write-Host "Render の API に送っています…" -ForegroundColor Cyan
  & node "$PSScriptRoot\scripts\set-render-supabase-env.js"
  if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "失敗しました。上の英文を控えて、秘密を含めずに聞いてください。" -ForegroundColor Red
    $script:ExitCode = $LASTEXITCODE
  } else {
    Write-Host ""
    Write-Host "完了しました。" -ForegroundColor Green
    Write-Host "Render の画面でサービスが再デプロイされたか確認してください。" -ForegroundColor Yellow
    Write-Host "ログに「Supabase テーブル」と出れば成功です。" -ForegroundColor Yellow
  }
} catch {
  if ($_.Exception.Message -ne "no-node") {
    Write-Host ""
    Write-Host "エラー: $($_.Exception.Message)" -ForegroundColor Red
    $script:ExitCode = 1
  }
} finally {
  Write-Host ""
  Read-Host "ウィンドウを閉じるには Enter を押してください"
}

exit $script:ExitCode
