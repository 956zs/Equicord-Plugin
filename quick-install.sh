#!/usr/bin/env bash
set -euo pipefail

if [ "$(id -u)" -eq 0 ]; then
    echo "Run me as normal user, not root!"
    exit 1
fi

if grep -q "CHROMEOS_RELEASE_NAME" /etc/lsb-release 2>/dev/null; then
    echo "ChromeOS is not supported by this installer flow."
    exit 1
fi

CACHE_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/custom-vertical-writer"
INSTALLER_PATH="$CACHE_DIR/EquilotlCli-Linux"
ASAR_PATH="$CACHE_DIR/desktop.asar"
XDG_CONFIG_HOME_VALUE="${XDG_CONFIG_HOME:-}"

mkdir -p "$CACHE_DIR"

echo "Downloading official Equilotl CLI..."
curl -sS https://github.com/Equicord/Equilotl/releases/latest/download/EquilotlCli-Linux \
  --output "$INSTALLER_PATH" \
  --location \
  --fail

chmod +x "$INSTALLER_PATH"

echo "Downloading custom Equicord desktop.asar..."
curl -sS https://github.com/956zs/Equicord/releases/latest/download/desktop.asar \
  --output "$ASAR_PATH" \
  --location \
  --fail

set -- \
  "EQUICORD_DIRECTORY=$ASAR_PATH" \
  "EQUICORD_DEV_INSTALL=1" \
  "XDG_CONFIG_HOME=$XDG_CONFIG_HOME_VALUE"

if command -v sudo >/dev/null; then
  echo "Running installer with sudo"
  sudo env "$@" "$INSTALLER_PATH"
elif command -v doas >/dev/null; then
  echo "Running installer with doas"
  doas env "$@" "$INSTALLER_PATH"
elif command -v run0 >/dev/null; then
  echo "Running installer with run0"
  run0 env "$@" "$INSTALLER_PATH"
elif command -v pkexec >/dev/null; then
  echo "Running installer with pkexec"
  pkexec env "$@" "SUDO_USER=$(whoami)" "$INSTALLER_PATH"
else
  echo "Neither sudo nor doas were found. Please install one of them to proceed."
  exit 1
fi
