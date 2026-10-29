# Copy plugins from this repo into an Equicord/Vencord source checkout.
# Usage: .\install.ps1 -TargetRepo C:\path\to\Equicord [-Plugins name1,name2]   (no -Plugins = all)
param(
    [Parameter(Mandatory = $true)]
    [string]$TargetRepo,
    [string[]]$Plugins
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$TargetSrc = Join-Path $TargetRepo "src"

if (-not (Test-Path $TargetSrc)) {
    Write-Error "Target repo does not look like an Equicord/Vencord source checkout: $TargetRepo"
    exit 1
}

if (-not $Plugins) {
    $Plugins = Get-ChildItem -Directory $ScriptDir |
        Where-Object { (Test-Path (Join-Path $_.FullName "index.ts")) -or (Test-Path (Join-Path $_.FullName "index.tsx")) } |
        ForEach-Object { $_.Name }
}

$UserPlugins = Join-Path $TargetSrc "userplugins"
New-Item -ItemType Directory -Force -Path $UserPlugins | Out-Null

foreach ($Name in $Plugins) {
    $Source = Join-Path $ScriptDir $Name
    if (-not (Test-Path $Source)) {
        Write-Error "Unknown plugin: $Name"
        exit 1
    }
    $Dest = Join-Path $UserPlugins $Name
    if (Test-Path $Dest) { Remove-Item -Recurse -Force $Dest }
    Copy-Item -Recurse $Source $Dest
    Write-Host "Installed $Name"
}

Write-Host ""
Write-Host "Next steps:"
Write-Host "  cd `"$TargetRepo`"; pnpm build"
Write-Host "  then reload Discord with Ctrl+R (run pnpm inject first if this build is not injected yet)"
