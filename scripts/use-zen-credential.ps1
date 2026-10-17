<#
Switch the gateway onto the credential-authenticated Zen lane.

The anonymous lane (/inference/v1 with `Bearer public`) is the one behind the
environment fingerprint. A credential moves the request onto a different check:
probing showed `/zen/v1` and `/zen/go/v1` answer `401 Invalid credential` for a
dummy key and never `403 FreeTierError`, while the anonymous lane answers 403.

So an authenticated key does not need the fingerprint at all.

  .\scripts\use-zen-credential.ps1 -ApiKey 'sk-...'
      personal Zen subscription -> /zen/v1/chat/completions

  .\scripts\use-zen-credential.ps1 -ApiKey 'sk-...' -Lane go
      team/subscription lane -> /zen/go/v1/chat/completions

  .\scripts\use-zen-credential.ps1 -Revert
      back to the anonymous lane
#>
param(
  [string]$ApiKey,
  [ValidateSet("zen", "go")][string]$Lane = "zen",
  [switch]$Revert
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $root ".env"
if (-not (Test-Path $envFile)) { throw "missing $envFile" }

$lines = Get-Content $envFile
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
Copy-Item $envFile "$envFile.bak-$stamp"

$path = if ($Revert) { "/inference/v1/chat/completions" } elseif ($Lane -eq "go") { "/zen/go/v1/chat/completions" } else { "/zen/v1/chat/completions" }
$key = if ($Revert) { "public" } else { $ApiKey }
if (-not $Revert -and [string]::IsNullOrWhiteSpace($key)) { throw "pass -ApiKey, or -Revert to go back to the anonymous lane" }

$set = [ordered]@{ ZEN_PATH = $path; ZEN_API_KEY = $key }
$out = New-Object System.Collections.Generic.List[string]
$seen = @{}
foreach ($line in $lines) {
  $hit = $false
  foreach ($name in $set.Keys) {
    if ($line -match "^\s*$([regex]::Escape($name))=") {
      $out.Add("$name=$($set[$name])")
      $seen[$name] = $true
      $hit = $true
      break
    }
  }
  if (-not $hit) { $out.Add($line) }
}
foreach ($name in $set.Keys) { if (-not $seen.ContainsKey($name)) { $out.Add("$name=$($set[$name])") } }

Set-Content -LiteralPath $envFile -Value $out -Encoding utf8

$shown = if ($Revert) { "public (anonymous)" } else { $key.Substring(0, [Math]::Min(6, $key.Length)) + "..." }
Write-Host "ZEN_PATH   = $path"
Write-Host "ZEN_API_KEY= $shown"
Write-Host "backup     = $envFile.bak-$stamp"
Write-Host ""
Write-Host "Restart the gateway to apply:"
Write-Host "  Get-NetTCPConnection -State Listen -LocalPort 6446 | % { Stop-Process -Id `$_.OwningProcess -Force }"
Write-Host "  # the keep-alive loop relaunches it within ~15s; then check /health"
