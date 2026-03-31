#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
    echo "Usage: ./install.sh /path/to/Equicord-or-Vencord"
    exit 1
fi

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
TARGET_REPO="$1"
TARGET_PLUGIN_DIR="$TARGET_REPO/src/userplugins/customVerticalWriter"

if [[ ! -d "$TARGET_REPO/src" ]]; then
    echo "Target repo does not look like an Equicord/Vencord source checkout: $TARGET_REPO"
    exit 1
fi

mkdir -p "$TARGET_PLUGIN_DIR"
cp "$SCRIPT_DIR/customVerticalWriter/index.tsx" "$TARGET_PLUGIN_DIR/index.tsx"

echo "Installed plugin into:"
echo "  $TARGET_PLUGIN_DIR/index.tsx"
echo
echo "Next steps:"
echo "  1. cd \"$TARGET_REPO\""
echo "  2. pnpm build"
echo "  3. reload Discord (or run pnpm inject if this source build is not patched yet)"
