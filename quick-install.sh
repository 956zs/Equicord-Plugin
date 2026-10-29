#!/usr/bin/env bash
# One-shot install: clone (or update) official Equicord, add the plugins from
# this repo, build and inject into Discord.
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/956zs/Equicord-Plugin/main/quick-install.sh)"
# Env: EQUICORD_DIR (default ~/Equicord). Extra args = plugin names to install (default all).
set -euo pipefail

EQUICORD_DIR="${EQUICORD_DIR:-$HOME/Equicord}"
EQUICORD_REPO="https://github.com/Equicord/Equicord.git"
PLUGIN_REPO="https://github.com/956zs/Equicord-Plugin.git"

for cmd in git node; do
    command -v "$cmd" >/dev/null || { echo "Missing dependency: $cmd"; exit 1; }
done

if command -v pnpm >/dev/null; then
    PNPM=(pnpm)
elif command -v corepack >/dev/null; then
    PNPM=(corepack pnpm)
else
    echo "Missing dependency: pnpm (or corepack, bundled with Node.js)"
    exit 1
fi

if [[ -d "$EQUICORD_DIR/.git" ]]; then
    echo "Updating Equicord in $EQUICORD_DIR"
    git -C "$EQUICORD_DIR" pull --ff-only
else
    echo "Cloning Equicord into $EQUICORD_DIR"
    git clone --depth 1 "$EQUICORD_REPO" "$EQUICORD_DIR"
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
git clone --depth 1 "$PLUGIN_REPO" "$TMP/plugins"
bash "$TMP/plugins/install.sh" "$EQUICORD_DIR" "$@"

cd "$EQUICORD_DIR"
"${PNPM[@]}" install --frozen-lockfile
"${PNPM[@]}" build
"${PNPM[@]}" inject

echo
echo "Done. Fully restart Discord, then enable the plugins in Settings > Equicord > Plugins."
