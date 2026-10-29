# One-shot install: clone (or update) official Equicord, add the plugins from
# this repo, build and inject into Discord.
#   powershell -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/956zs/Equicord-Plugin/main/quick-install.ps1 | iex"
# Env: EQUICORD_DIR (default %USERPROFILE%\Equicord). Installs all plugins.
$ErrorActionPreference = "Stop"

$EquicordDir = if ($env:EQUICORD_DIR) { $env:EQUICORD_DIR } else { Join-Path $HOME "Equicord" }
$EquicordRepo = "https://github.com/Equicord/Equicord.git"
$PluginRepo = "https://github.com/956zs/Equicord-Plugin.git"

foreach ($Cmd in "git", "node") {
    if (-not (Get-Command $Cmd -ErrorAction SilentlyContinue)) { throw "Missing dependency: $Cmd" }
}

if (Get-Command pnpm -ErrorAction SilentlyContinue) {
    function Invoke-Pnpm { & pnpm @args; if ($LASTEXITCODE) { throw "pnpm $args failed" } }
} elseif (Get-Command corepack -ErrorAction SilentlyContinue) {
    function Invoke-Pnpm { & corepack pnpm @args; if ($LASTEXITCODE) { throw "pnpm $args failed" } }
} else {
    throw "Missing dependency: pnpm (or corepack, bundled with Node.js)"
}

if (Test-Path (Join-Path $EquicordDir ".git")) {
    Write-Host "Updating Equicord in $EquicordDir"
    git -C $EquicordDir pull --ff-only
} else {
    Write-Host "Cloning Equicord into $EquicordDir"
    git clone --depth 1 $EquicordRepo $EquicordDir
}
if ($LASTEXITCODE) { throw "git failed" }

$Tmp = Join-Path ([System.IO.Path]::GetTempPath()) ([System.Guid]::NewGuid())
try {
    git clone --depth 1 $PluginRepo (Join-Path $Tmp "plugins")
    if ($LASTEXITCODE) { throw "git clone failed" }
    & (Join-Path $Tmp "plugins\install.ps1") -TargetRepo $EquicordDir

    Push-Location $EquicordDir
    try {
        Invoke-Pnpm install --frozen-lockfile
        Invoke-Pnpm build
        Invoke-Pnpm inject
    } finally {
        Pop-Location
    }
} finally {
    Remove-Item -Recurse -Force $Tmp -ErrorAction SilentlyContinue
}

Write-Host ""
Write-Host "Done. Fully restart Discord, then enable the plugins in Settings > Equicord > Plugins."
