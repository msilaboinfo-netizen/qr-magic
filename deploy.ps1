<#.SYNOPSIS
  変更を GitHub に push し、Render の Deploy Hook を叩く（1本で完了）。
  初回: .env に RENDER_DEPLOY_HOOK=... を入れる。Git 未使用なら -SkipGit
.EXAMPLE
  cd C:\Users\user\Desktop\qr-magic
  .\deploy.ps1
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File "C:\Users\user\Desktop\qr-magic\deploy.ps1"
#>
param(
  [switch] $SkipGit
)

Set-Location -LiteralPath $PSScriptRoot
$oldEap = $ErrorActionPreference
$ErrorActionPreference = "Continue"

function Invoke-GitDeploy {
  if (-not (Test-Path -LiteralPath ".git")) {
    Write-Host "[deploy] No .git in this folder - skipped git push."
    Write-Host "[deploy] Render still builds from GitHub. Upload local changes to GitHub or run: git init + remote + push"
    return
  }
  $remote = git remote 2>$null
  if (-not $remote) {
    Write-Host "[deploy] No git remote - skipped push. Add origin then retry."
    return
  }
  $dirty = git status --porcelain 2>$null
  if ($dirty) {
    git add -A
    $msg = "deploy {0:yyyy-MM-dd HH:mm}" -f (Get-Date)
    git commit -m $msg
    if ($LASTEXITCODE -ne 0) {
      $ErrorActionPreference = $oldEap
      Write-Error "git commit failed"
      exit 1
    }
  }
  # git writes "Everything up-to-date" to stderr; PowerShell would show it as a red error if we used 2>&1 here.
  cmd /c "git push 2>&1"
  if ($LASTEXITCODE -ne 0) {
    $ErrorActionPreference = $oldEap
    Write-Error "git push failed"
    exit 1
  }
  Write-Host "[deploy] git push OK"
}

if (-not $SkipGit) {
  Invoke-GitDeploy
}

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  $ErrorActionPreference = $oldEap
  Write-Error "node not found in PATH. Install Node.js or open a shell where node works."
  exit 1
}

& node "$PSScriptRoot\scripts\deploy-render.js"
$code = $LASTEXITCODE
$ErrorActionPreference = $oldEap
exit $code
