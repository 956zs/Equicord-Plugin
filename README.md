# Custom Vertical Writer

Private/shareable `userplugin` for Equicord and Vencord.

It adds a candy-cane toggle button to the Discord chat bar. When the toggle is on, outgoing messages are converted into your custom right-to-left vertical layout.

## Repo Layout

```text
customVerticalWriter/
  index.tsx
quick-install.sh
quick-install.ps1
install.sh
install.ps1
```

## Quick Install

Canonical install entrypoints live in your Equicord fork:

- Linux/macOS:
  `https://raw.githubusercontent.com/956zs/Equicord/main/misc/install.sh`
- Windows PowerShell:
  `https://raw.githubusercontent.com/956zs/Equicord/main/misc/install.ps1`

They install the latest rolling release from:

- `https://github.com/956zs/Equicord/releases/latest`

### Equicord on Linux/macOS

```bash
sh -c "$(curl -fsSL https://raw.githubusercontent.com/956zs/Equicord/main/misc/install.sh)"
```

### Equicord on Windows PowerShell

```powershell
powershell -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/956zs/Equicord/main/misc/install.ps1 | iex"
```

The local `quick-install.sh` and `quick-install.ps1` files in this repo are convenience wrappers around those same URLs.

## Source Install

### Equicord or Vencord on Linux/macOS

```bash
./install.sh /path/to/Equicord
# or
./install.sh /path/to/Vencord
```

### Equicord or Vencord on Windows PowerShell

```powershell
.\install.ps1 -TargetRepo "C:\Users\you\Documents\Equicord"
# or
.\install.ps1 -TargetRepo "C:\Users\you\Documents\Vencord"
```

The installer copies:

```text
customVerticalWriter/index.tsx
```

into:

```text
src/userplugins/customVerticalWriter/index.tsx
```

## Build After Install

### Equicord

Official docs say user plugins require a source build and must be rebuilt after adding or changing them.

```bash
pnpm install --no-frozen-lockfile
pnpm build
pnpm inject
```

Use `pnpm build --watch` while developing for faster iteration, then reload Discord with `Ctrl+R`.

### Vencord

Official docs say custom plugins must live in `src/userplugins/` and you must rebuild after changes.

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm inject
```

For Vesktop, point `Vencord Location` to the `dist` folder of your Vencord source checkout and restart Vesktop after rebuilding.

## Update Workflow

### If you only changed this plugin

- You do not need to `git pull` the whole Equicord/Vencord repo.
- Rebuild the target client repo.
- If you already injected that source build once, usually a rebuild plus Discord reload is enough for testing.

### If you use the quick-install release flow

- Push changes to `956zs/Equicord-Plugin`
- The fork CI syncs the plugin into `956zs/Equicord`
- The fork CI builds a fresh rolling release
- Friends can rerun `quick-install.sh` or `quick-install.ps1`

### If you want the latest Equicord/Vencord upstream changes

- Yes, pull the target client repo:

```bash
git pull
```

- Then reinstall dependencies if needed and rebuild.

Equicord:

```bash
pnpm install --no-frozen-lockfile
pnpm build
```

Vencord:

```bash
pnpm install --frozen-lockfile
pnpm build
```

### When do you need `pnpm inject` again?

Usually only when:

- it is your first install
- Discord updated and removed the patch
- you switched to a different Discord branch/install
- the patched install broke or was reinstalled

For normal plugin edits, `inject` is usually not needed every single time.

## Official References

- Equicord Plugins & Development: https://docs.equicord.org/plugins
- Equicord Building from Source: https://docs.equicord.org/building-from-source
- Vencord Installing custom plugins: https://docs.vencord.dev/installing/custom-plugins/
- Vencord Installing from source: https://docs.vencord.dev/installing/
