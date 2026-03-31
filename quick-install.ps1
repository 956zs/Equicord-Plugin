$ErrorActionPreference = "Stop"

$CacheDir = Join-Path $env:LOCALAPPDATA "CustomVerticalWriter"
$InstallerPath = Join-Path $CacheDir "EquilotlCli.exe"
$AsarPath = Join-Path $CacheDir "desktop.asar"

New-Item -ItemType Directory -Force -Path $CacheDir | Out-Null

Write-Host "Downloading official Equilotl CLI..."
Invoke-WebRequest -Uri "https://github.com/Equicord/Equilotl/releases/latest/download/EquilotlCli.exe" -OutFile $InstallerPath

Write-Host "Downloading custom Equicord desktop.asar..."
Invoke-WebRequest -Uri "https://github.com/956zs/Equicord/releases/latest/download/desktop.asar" -OutFile $AsarPath

$EscapedInstaller = $InstallerPath.Replace('"', '\"')
$EscapedAsar = $AsarPath.Replace('"', '\"')
$Command = "set ""EQUICORD_DIRECTORY=$EscapedAsar"" && set ""EQUICORD_DEV_INSTALL=1"" && ""$EscapedInstaller"""

Write-Host "Launching installer with elevation..."
$Process = Start-Process -FilePath "cmd.exe" -ArgumentList "/c $Command" -Verb RunAs -Wait -PassThru

if ($Process.ExitCode -ne 0) {
    throw "Installer failed with exit code $($Process.ExitCode)"
}
