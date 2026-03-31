param(
    [Parameter(Mandatory = $true)]
    [string]$TargetRepo
)

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$TargetSrc = Join-Path $TargetRepo "src"
$TargetPluginDir = Join-Path $TargetSrc "userplugins\customVerticalWriter"

if (-not (Test-Path $TargetSrc)) {
    Write-Error "Target repo does not look like an Equicord/Vencord source checkout: $TargetRepo"
    exit 1
}

New-Item -ItemType Directory -Force -Path $TargetPluginDir | Out-Null
Copy-Item -Force (Join-Path $ScriptDir "customVerticalWriter\index.tsx") (Join-Path $TargetPluginDir "index.tsx")

Write-Host "Installed plugin into:"
Write-Host "  $TargetPluginDir\index.tsx"
Write-Host ""
Write-Host "Next steps:"
Write-Host "  1. cd `"$TargetRepo`""
Write-Host "  2. pnpm build"
Write-Host "  3. reload Discord (or run pnpm inject if this source build is not patched yet)"
