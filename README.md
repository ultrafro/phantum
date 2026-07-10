# 👻 phantum

**A dashboard for managing all your Claude Code terminals on one screen.**

phantum runs a small local server on your PC and gives you a browser-based
control panel: a list of your terminals ("chats") on the left, and as many live
terminal panes as you want tiled on the right. Click a chat to open it as a
pane; click again to tuck it away. Your layout and every terminal's settings are
**saved automatically**, so the whole cockpit comes right back up after a
restart.

Each pane is a **real Windows terminal** (ConPTY via `node-pty`), so everything
Claude Code needs works — colors, interactive prompts, resizing, and
**clipboard image paste** (see [below](#does-image-paste-alt--v-work)).

> Built for Windows, but the server runs anywhere Node does.

---

## Features

- **Sidebar of chats** — name, working directory, launch command, live
  running/stopped status, and "last accessed" for each.
- **Open many panes at once** — click chats to tile them; auto-layout or pick
  1/2/3 columns.
- **Real terminals** — full ConPTY fidelity; run `claude`, PowerShell, cmd,
  Git Bash, or any executable.
- **Per-chat commands & flags** — pick a shell and toggle common Claude flags
  like `--dangerously-skip-permissions`, `--continue`, and `--model`, or add
  any extra arguments.
- **Sessions survive reloads** — closing a pane keeps its process running on
  the server; reopen it to pick up right where you left off. (A full app
  restart starts fresh terminals — old processes don't outlive the server.)
- **Autosave** — layout, open panes, columns, and chat configs persist to
  `phantum.config.json` continuously.
- **Save / share / load configs** — export your whole setup as JSON, hand it to
  a teammate, and load theirs.
- **Double-click to run** — no build step.

---

## Quick start

**Requirements:** [Node.js](https://nodejs.org) 18+ installed. (For the
`claude` command to work in a pane, the [Claude Code
CLI](https://docs.claude.com/en/docs/claude-code) must be on your PATH.)

### The easy way (Windows)

1. Download / clone this repo.
2. **Double-click `phantum.vbs`.**
   - First launch installs dependencies automatically (one time).
   - It then opens phantum in its own app window.
3. Click **＋ New** to create your first terminal.

To stop the background server, double-click **`stop-phantum.vbs`**.

### The manual way (any OS)

```bash
npm install
npm start
# then open http://127.0.0.1:7333
```

`phantum.bat` does the same thing but keeps the server log visible in a console
window.

### Desktop shortcut with an icon

To drop a nicely-iconed **phantum** shortcut on your desktop (handles OneDrive
desktop redirection automatically):

```powershell
powershell -ExecutionPolicy Bypass -File scripts\make-shortcut.ps1
```

That points a `phantum.lnk` at `phantum.vbs` and gives it `phantum.ico` (the
ghost mark). Re-generate the icon anytime with
`scripts\make-icon.ps1`. Add `-AllDesktops` to place it on both the OneDrive and
classic desktop folders.

---

## Using it

| Action | How |
| --- | --- |
| New terminal | **＋ New** — set name, folder, command, and flags |
| Open / close a pane | Click a chat in the sidebar |
| Edit a chat | Hover the chat → ✎ |
| Restart a terminal | Hover the chat or pane → ⟳ |
| Delete a chat | Hover the chat → 🗑 |
| Change layout | **Columns** control at the bottom-left |
| Export config | **⚙ Config → Export JSON** |
| Save a snapshot | **⚙ Config → Save config as…** |
| Load a config | **⚙ Config → Load / import JSON** |

### Copy & paste in a pane

| Shortcut | Does |
| --- | --- |
| `Ctrl+V` / `Alt+V` | Paste — forwarded straight to Claude Code so it can grab **images** from your clipboard |
| `Ctrl+Shift+V` | Paste clipboard **text** (bracketed) |
| `Ctrl+Shift+C` | Copy the current selection |
| Right-click | Paste clipboard text |
| `Ctrl+C` | Stays SIGINT (interrupt), as in any terminal |

### Does image paste (Alt / Ctrl + V) work?

**Yes.** Claude Code reads the operating-system clipboard *itself* when it
receives the paste keystroke — it doesn't depend on the terminal shipping the
image over the wire. phantum forwards the raw `Ctrl+V` / `Alt+V` keystroke
directly to the pty (and stops the browser from hijacking it), so Claude Code
sees the keypress and pulls the image from the same Windows clipboard you copied
it to. Panes launched in the app-mode window (Edge/Chrome `--app`) also reclaim
most reserved shortcuts.

---

## Configuration

Everything lives in **`phantum.config.json`** next to the app (override the
location with the `PHANTUM_CONFIG` env var). It's plain JSON — see
[`config.example.json`](./config.example.json). A chat looks like:

```json
{
  "id": "abc123",
  "name": "phantum",
  "cwd": "C:\\side\\phantum",
  "shell": "claude",
  "args": ["--dangerously-skip-permissions"],
  "lastAccessed": 1720000000000
}
```

`shell` accepts the shortcuts `claude`, `pwsh`, `powershell`, `cmd`, `bash`, or
any executable name/path. `args` is passed to it verbatim.

### Environment variables

| Var | Default | Purpose |
| --- | --- | --- |
| `PORT` / `PHANTUM_PORT` | `7333` | Server port |
| `PHANTUM_HOST` | `127.0.0.1` | Bind address |
| `PHANTUM_CONFIG` | `./phantum.config.json` | Config file path |

---

## How it works

```
 browser (xterm.js panes)  ──WebSocket──►  Node server  ──ConPTY──►  claude / shells
        ▲                                      │
        └──────────  REST /api/config  ◄────────┘   (autosaved to phantum.config.json)
```

- **`server.js`** — Express serves the UI and a REST API; a WebSocket per pane
  bridges keystrokes and output to a pty.
- **`lib/terminals.js`** — spawns and tracks one live pty per chat, buffering
  recent output so reconnecting panes replay the current screen.
- **`lib/store.js`** — loads/saves the config with debounced atomic writes.
- **`public/`** — the xterm.js front-end (no build step; served from
  `node_modules`).

---

## Security note

phantum binds to `127.0.0.1` only and is meant to run on your own machine. It
spawns real shells with the arguments you configure and can browse your
filesystem for the folder picker — don't expose the port to untrusted networks.

---

## License

MIT © ultrafro
