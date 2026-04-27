<#.SYNOPSIS
  .env の Supabase / Render API 情報を使い、Render に環境変数を自動設定する。
  事前: Supabase で SQL はブラウザから実行済み。.env に RENDER_* と SUPABASE_* を書く。
.EXAMPLE
  cd C:\Users\user\Desktop\qr-magic
  .\render-supabase-env.ps1
#>
Set-Location -LiteralPath $PSScriptRoot
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Error "node が PATH にありません。Node.js を入れるか、PATH を通してください。"
  exit 1
}
& node "$PSScriptRoot\scripts\set-render-supabase-env.js"
exit $LASTEXITCODE
