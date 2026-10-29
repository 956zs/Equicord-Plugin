#!/usr/bin/env bash
# Copy plugins from this repo into an Equicord/Vencord source checkout.
# Usage: ./install.sh /path/to/Equicord [plugin ...]   (no plugin names = all)
set -euo pipefail

if [[ $# -lt 1 ]]; then
    echo "Usage: ./install.sh /path/to/Equicord-or-Vencord [plugin ...]"
    exit 1
fi

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
TARGET_REPO="$1"
shift

if [[ ! -d "$TARGET_REPO/src" ]]; then
    echo "Target repo does not look like an Equicord/Vencord source checkout: $TARGET_REPO"
    exit 1
fi

if [[ $# -gt 0 ]]; then
    PLUGINS=("$@")
else
    PLUGINS=()
    for dir in "$SCRIPT_DIR"/*/; do
        name="$(basename "$dir")"
        [[ -f "$dir/index.ts" || -f "$dir/index.tsx" ]] && PLUGINS+=("$name")
    done
fi

mkdir -p "$TARGET_REPO/src/userplugins"
for name in "${PLUGINS[@]}"; do
    if [[ ! -d "$SCRIPT_DIR/$name" ]]; then
        echo "Unknown plugin: $name"
        exit 1
    fi
    rm -rf "$TARGET_REPO/src/userplugins/$name"
    cp -r "$SCRIPT_DIR/$name" "$TARGET_REPO/src/userplugins/$name"
    echo "Installed $name"
done

echo
echo "Next steps:"
echo "  cd \"$TARGET_REPO\" && pnpm build"
echo "  then reload Discord with Ctrl+R (run pnpm inject first if this build is not injected yet)"
