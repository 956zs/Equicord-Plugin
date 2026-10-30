# Equicord-Plugin

My `userplugins` for [Equicord](https://github.com/Equicord/Equicord) (they also work with Vencord).

## Plugins

| Plugin | What it does |
| --- | --- |
| [`alwaysTyping`](./alwaysTyping) | Adds a keyboard button to the chat bar. Turn it on in a channel and your typing indicator stays visible there (re-sent every 8 s, adjustable 3–9 s) until you turn it off. Not saved across reloads; stops by itself if you lack permission to type. |
| [`customVerticalWriter`](./customVerticalWriter) | Adds a candy-cane toggle to the chat bar. When on, outgoing messages are converted into a right-to-left vertical layout. |
| [`sessionRadar`](./sessionRadar) | Adds a button next to mute/deafen showing how many gateway sessions you have online. Click it for a native Discord menu listing each session (desktop / web / mobile / console, OS, status, activity, `ACTIVE` / `AFK`). Click a session to copy its ID. |
| [`instantAfk`](./instantAfk) | Overrides the "push notification inactive timeout" locally. Discord's server clamps it to at least 1 minute; with this plugin the client can report AFK after any number of seconds, or immediately (`0`), so pushes go to your phone right away. |

> `instantAfk` changes what your client reports to Discord. Client mods are against Discord's ToS; use at your own risk.

## Quick Install

Clones (or updates) official Equicord, adds every plugin from this repo, builds and injects into Discord.

Requirements: `git`, Node.js (with `pnpm` or `corepack`).

### Linux / macOS

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/956zs/Equicord-Plugin/main/quick-install.sh)"
```

### Windows PowerShell

```powershell
powershell -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/956zs/Equicord-Plugin/main/quick-install.ps1 | iex"
```

- Equicord is cloned to `~/Equicord` (`%USERPROFILE%\Equicord` on Windows). Set `EQUICORD_DIR` to use another path.
- `pnpm inject` asks which Discord install to patch.
- Rerun the same command to update Equicord and the plugins.
- Afterwards, fully restart Discord and enable the plugins in **Settings → Equicord → Plugins**.

## Manual Install

If you already have an Equicord or Vencord source checkout:

```bash
git clone https://github.com/956zs/Equicord-Plugin.git
cd Equicord-Plugin
./install.sh /path/to/Equicord                    # all plugins
./install.sh /path/to/Equicord sessionRadar       # only some
```

```powershell
.\install.ps1 -TargetRepo "C:\path\to\Equicord"
.\install.ps1 -TargetRepo "C:\path\to\Equicord" -Plugins sessionRadar,instantAfk
```

This copies the plugin folders into `src/userplugins/`. Then build:

```bash
cd /path/to/Equicord
pnpm install --frozen-lockfile
pnpm build
pnpm inject   # first time only
```

For Vesktop, point **Vencord Location** to the `dist` folder of your source checkout and restart Vesktop.

## Updating

- **Plugin changes only:** rerun `install.sh`, then `pnpm build` and reload Discord with `Ctrl+R`. No need to inject again.
- **Equicord upstream:** `git pull`, `pnpm install --frozen-lockfile`, `pnpm build`.
- **Run `pnpm inject` again** when Discord updates (it installs into a new `app-x.y.z` folder and drops the patch), or after reinstalling Discord.

## References

- Equicord plugins & development: https://docs.equicord.org/plugins
- Equicord building from source: https://docs.equicord.org/building-from-source
- Vencord custom plugins: https://docs.vencord.dev/installing/custom-plugins/
