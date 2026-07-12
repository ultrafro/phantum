#!/usr/bin/env node
'use strict';

const http = require('http');
const path = require('path');
const os = require('os');
const fs = require('fs');
const url = require('url');
const crypto = require('crypto');
const express = require('express');
const { WebSocketServer } = require('ws');

const store = require('./lib/store');
const {
  TerminalManager,
  encodeProject,
  latestSessionId
} = require('./lib/terminals');

// High, uncommon default port — the old 7333 collided with other local Claude
// instances that grab/drop it. Override with PORT / PHANTUM_PORT if needed.
const PORT = Number(process.env.PORT || process.env.PHANTUM_PORT || 59333);
const HOST = process.env.PHANTUM_HOST || '127.0.0.1';

const app = express();
app.use(express.json({ limit: '4mb' }));

const manager = new TerminalManager();
let config = store.load();
assignSessionIds();

// Bumped on every whole-config replace. Clients send the rev they last saw so a
// stale background tab can't overwrite newer changes (optimistic concurrency).
let configRev = 1;

// ---- static assets --------------------------------------------------------

app.use(express.static(path.join(__dirname, 'public')));

// Serve the xterm.js runtime straight out of node_modules so there's no build
// step — this stays a plain `npm install && node server.js` project.
const xtermDir = path.join(__dirname, 'node_modules', '@xterm');
app.use('/vendor/xterm', express.static(path.join(xtermDir, 'xterm')));
app.use('/vendor/addon-fit', express.static(path.join(xtermDir, 'addon-fit')));
app.use(
  '/vendor/addon-web-links',
  express.static(path.join(xtermDir, 'addon-web-links'))
);

// ---- helpers --------------------------------------------------------------

function findChat(id) {
  return config.chats.find((c) => c.id === id);
}

function persist() {
  config = store.save(config);
}

// ---- Claude session-id management -----------------------------------------

function isClaudeChat(chat) {
  return (chat.shell || 'claude').toLowerCase() === 'claude';
}

function chatDirExists(cwd) {
  try {
    return fs.statSync(cwd).isDirectory();
  } catch (_) {
    return false;
  }
}

function usesContinue(chat) {
  return (chat.args || []).some((a) => a === '--continue' || a === '-c');
}

// An id the user already pinned via --resume/--session-id, if any.
function explicitSessionId(chat) {
  const a = chat.args || [];
  for (let i = 0; i < a.length; i++) {
    if (
      (a[i] === '--resume' || a[i] === '-r' || a[i] === '--session-id') &&
      a[i + 1] &&
      !a[i + 1].startsWith('-')
    ) {
      return a[i + 1];
    }
  }
  return null;
}

// Give a Claude chat a stable session id if it doesn't have one. Existing ids are
// adopted from an explicit flag; a chat that is the ONLY one using its folder
// adopts that folder's latest session (dedicated worktrees — safe); everything
// else (shared folders, brand-new chats) gets a fresh uuid so it starts clean but
// is deterministically resumable from then on.
function ensureSessionId(chat, claimed, cwdCounts) {
  if (!isClaudeChat(chat) || chat.sessionId || usesContinue(chat)) return false;

  const explicit = explicitSessionId(chat);
  if (explicit) {
    chat.sessionId = explicit;
    claimed.add(explicit);
    return true;
  }
  let picked = null;
  if (cwdCounts && cwdCounts[chat.cwd] === 1 && chatDirExists(chat.cwd)) {
    const latest = latestSessionId(encodeProject(chat.cwd));
    if (latest && !claimed.has(latest)) picked = latest;
  }
  chat.sessionId = picked || crypto.randomUUID();
  claimed.add(chat.sessionId);
  return true;
}

// Backfill session ids for every existing Claude chat at startup, so a full
// restart resumes the same conversations instead of spawning fresh instances.
function assignSessionIds() {
  const cwdCounts = {};
  for (const c of config.chats) {
    if (isClaudeChat(c)) cwdCounts[c.cwd] = (cwdCounts[c.cwd] || 0) + 1;
  }
  const claimed = new Set(config.chats.map((c) => c.sessionId).filter(Boolean));
  let changed = false;
  // Most-recently-used chats claim first (only affects fresh-uuid outcomes;
  // adoption is limited to unique folders so ordering can't mis-assign).
  const order = [...config.chats].sort(
    (a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0)
  );
  for (const chat of order) {
    if (ensureSessionId(chat, claimed, cwdCounts)) changed = true;
  }
  if (changed) persist();
}

function withStatus(cfg) {
  return {
    ...cfg,
    runtime: {
      status: manager.statusMap(),
      info: manager.infoMap(),
      configPath: store.CONFIG_PATH,
      platform: process.platform,
      homedir: os.homedir(),
      rev: configRev
    }
  };
}

// ---- config API -----------------------------------------------------------

// Full config + live terminal status. The UI hydrates from this on load.
app.get('/api/config', (req, res) => {
  res.json(withStatus(config));
});

// Replace the whole config (used for autosave of layout, and for "load config").
// POST is accepted too so the browser can flush via navigator.sendBeacon() on
// page hide / shutdown (beacons are always POST).
function replaceConfig(req, res) {
  const body = req.body || {};
  const incoming = store.normalize(body);
  const force = body._force === true;

  // Guard 1: never let an automatic or stale save erase a non-empty config.
  if (!force && config.chats.length > 0 && incoming.chats.length === 0) {
    console.warn('[phantum] refused a config save that would erase all chats');
    return res.status(409).json(withStatus(config));
  }
  // Guard 2: reject a write from a client that hadn't seen the current state (a
  // background tab left open across changes), so it can't revert newer chats.
  if (!force && body._baseRev != null && Number(body._baseRev) !== configRev) {
    return res.status(409).json(withStatus(config));
  }

  config = incoming;
  configRev++;
  persist();
  res.json(withStatus(config));
}
app.put('/api/config', replaceConfig);
app.post('/api/config', replaceConfig);

// Download the current config as a portable JSON file.
app.get('/api/config/export', (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader(
    'Content-Disposition',
    'attachment; filename="phantum.config.json"'
  );
  res.send(JSON.stringify(config, null, 2));
});

// ---- chat CRUD ------------------------------------------------------------

app.post('/api/chats', (req, res) => {
  const chat = store.normalizeChat({
    ...req.body,
    id: store.cryptoId(),
    createdAt: Date.now(),
    lastAccessed: Date.now()
  });
  // A new Claude chat gets its own stable session id up front (fresh, or the one
  // the user pinned via --resume) so it's resumable after a restart. No folder
  // adoption here — a brand-new chat should start its own conversation.
  if (isClaudeChat(chat) && !chat.sessionId && !usesContinue(chat)) {
    chat.sessionId = explicitSessionId(chat) || crypto.randomUUID();
  }
  config.chats.push(chat);
  persist();
  res.json(chat);
});

app.patch('/api/chats/:id', (req, res) => {
  const chat = findChat(req.params.id);
  if (!chat) return res.status(404).json({ error: 'not found' });
  const merged = store.normalizeChat({ ...chat, ...req.body, id: chat.id });
  Object.assign(chat, merged);
  persist();
  res.json(chat);
});

app.delete('/api/chats/:id', (req, res) => {
  const idx = config.chats.findIndex((c) => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'not found' });
  manager.kill(req.params.id);
  config.chats.splice(idx, 1);
  config.layout.openChatIds = config.layout.openChatIds.filter(
    (id) => id !== req.params.id
  );
  persist();
  res.json({ ok: true });
});

// ---- terminal control -----------------------------------------------------

// Mark a chat as accessed now (called when its pane opens/focuses).
app.post('/api/chats/:id/touch', (req, res) => {
  const chat = findChat(req.params.id);
  if (!chat) return res.status(404).json({ error: 'not found' });
  chat.lastAccessed = Date.now();
  persist();
  res.json({ ok: true });
});

// Restart the terminal for a chat (kills the old process, spawns fresh).
app.post('/api/chats/:id/restart', (req, res) => {
  const chat = findChat(req.params.id);
  if (!chat) return res.status(404).json({ error: 'not found' });
  manager.restart(chat);
  res.json({ ok: true, status: 'running' });
});

// Stop (kill) a chat's terminal without deleting the chat.
app.post('/api/chats/:id/stop', (req, res) => {
  manager.kill(req.params.id);
  res.json({ ok: true, status: 'stopped' });
});

// List directory entries — powers the folder picker in the new-chat dialog.
app.get('/api/fs', (req, res) => {
  let dir = req.query.path;
  if (!dir || dir === '~') dir = os.homedir();
  try {
    dir = path.resolve(dir);
    const entries = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => ({ name: d.name, path: path.join(dir, d.name) }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const parent = path.dirname(dir);
    res.json({ dir, parent: parent === dir ? null : parent, entries });
  } catch (err) {
    res.status(400).json({ error: err.message, dir });
  }
});

app.get('/api/status', (req, res) => {
  res.json({ status: manager.statusMap(), info: manager.infoMap(), rev: configRev });
});

// Graceful shutdown (used by the system-tray "Exit"). Localhost-only since the
// server binds 127.0.0.1. Runs the normal shutdown path so every child pty
// (Claude session) is killed cleanly and the config is flushed first.
app.post('/api/shutdown', (req, res) => {
  res.json({ ok: true });
  console.log('[phantum] shutdown requested via API');
  setTimeout(shutdown, 100);
});

// Native OS folder picker. The browser can't open a real Explorer dialog, but
// the server runs on the user's own desktop, so it shells out to the Windows
// folder-browser dialog and returns the chosen path. Falls back gracefully on
// non-Windows (the in-app browser handles those).
app.post('/api/pick-folder', (req, res) => {
  if (process.platform !== 'win32') {
    return res.status(501).json({ error: 'native picker is Windows-only' });
  }
  const start = String((req.body && req.body.start) || '').replace(/'/g, "''");
  // Classic FolderBrowserDialog — on Win10/11 .NET auto-upgrades it to the modern
  // Explorer-style chooser. The server runs in the background, so it can't grab
  // the foreground normally (the dialog would open *behind* the app window and
  // look like nothing happened). A TopMost owner plus the ALT-key foreground-lock
  // bypass + SetForegroundWindow pulls the dialog to the front.
  const ps = `
Add-Type -AssemblyName System.Windows.Forms | Out-Null
Add-Type -Namespace PW -Name N -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetForegroundWindow(System.IntPtr h); [DllImport("user32.dll")] public static extern void keybd_event(byte b, byte s, uint f, System.IntPtr e);'
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true; $owner.ShowInTaskbar = $false; $owner.Opacity = 0
$owner.StartPosition = 'CenterScreen'
$owner.Size = New-Object System.Drawing.Size(1,1)
$owner.Show(); $owner.Activate()
[PW.N]::keybd_event(0x12,0,0,[System.IntPtr]::Zero)
[PW.N]::keybd_event(0x12,0,2,[System.IntPtr]::Zero)
[PW.N]::SetForegroundWindow($owner.Handle) | Out-Null
$dlg = New-Object System.Windows.Forms.FolderBrowserDialog
$dlg.Description = 'phantum - select working directory'
$dlg.ShowNewFolderButton = $true
$sp = '${start}'
if ($sp -and (Test-Path -LiteralPath $sp)) { $dlg.SelectedPath = $sp }
$r = $dlg.ShowDialog($owner)
$owner.Close()
if ($r -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dlg.SelectedPath) }
`;
  const b64 = Buffer.from(ps, 'utf16le').toString('base64');
  const child = require('child_process').execFile(
    'powershell.exe',
    ['-NoProfile', '-STA', '-EncodedCommand', b64],
    { timeout: 3 * 60 * 1000, windowsHide: true },
    (err, stdout) => {
      const picked = (stdout || '').trim();
      if (picked) return res.json({ path: picked });
      if (err && err.killed) return res.json({ canceled: true, error: 'timed out' });
      res.json({ canceled: true });
    }
  );
  child.on('error', (e) => {
    if (!res.headersSent) res.status(500).json({ error: e.message });
  });
});

// Look up which directory a Claude Code session belongs to. `claude --resume
// <id>` only finds a session when launched from that session's project dir, so
// the new-chat dialog uses this to auto-fill the working directory.
function findSessionCwd(id) {
  const base = path.join(os.homedir(), '.claude', 'projects');
  let dirs;
  try {
    dirs = fs.readdirSync(base);
  } catch (_) {
    return null;
  }
  for (const d of dirs) {
    const file = path.join(base, d, id + '.jsonl');
    if (!fs.existsSync(file)) continue;
    // Read only the head of the file — sessions record their cwd on each entry.
    let cwd = null;
    try {
      const fd = fs.openSync(file, 'r');
      const buf = Buffer.alloc(65536);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      fs.closeSync(fd);
      const m = buf.toString('utf8', 0, n).match(/"cwd":"((?:[^"\\]|\\.)*)"/);
      if (m) {
        try {
          cwd = JSON.parse('"' + m[1] + '"');
        } catch (_) {
          cwd = m[1].replace(/\\\\/g, '\\');
        }
      }
    } catch (_) {}
    return { project: d, cwd };
  }
  return null;
}

app.get('/api/claude/session', (req, res) => {
  const id = String(req.query.id || '').trim();
  // Session ids are uuids; reject anything else so this can't be used to probe
  // the filesystem.
  if (!/^[a-zA-Z0-9-]{8,}$/.test(id)) return res.json({ found: false });
  const info = findSessionCwd(id);
  if (!info) return res.json({ found: false });
  res.json({ found: true, cwd: info.cwd, project: info.project });
});

// ---- HTTP + WebSocket wiring ----------------------------------------------

const server = http.createServer(app);

// One WebSocket per open pane. `?chatId=…` selects the terminal; the server
// spawns it on first connect and reattaches (replaying scrollback) on reconnect.
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const { pathname } = url.parse(req.url);
  if (pathname !== '/ws') {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

wss.on('connection', (ws, req) => {
  const { query } = url.parse(req.url, true);
  const chat = findChat(query.chatId);
  if (!chat) {
    ws.send(
      JSON.stringify({ __phantum: 'error', message: 'unknown chat' })
    );
    ws.close();
    return;
  }

  chat.lastAccessed = Date.now();
  persist();

  const term = manager.ensure(chat);
  term.attach(ws);

  ws.on('message', (raw) => {
    // Control frames are JSON ({type:'resize'|'input'}); everything else is
    // treated as raw keystrokes to write straight into the pty.
    let msg = null;
    const text = raw.toString();
    if (text.length && text[0] === '{') {
      try {
        msg = JSON.parse(text);
      } catch (_) {
        msg = null;
      }
    }
    if (msg && msg.type === 'resize') {
      term.resize(msg.cols, msg.rows);
    } else if (msg && msg.type === 'input') {
      term.write(msg.data);
    } else {
      term.write(text);
    }
  });

  ws.on('close', () => term.detach(ws));
  ws.on('error', () => term.detach(ws));
});

// ---- lifecycle ------------------------------------------------------------

server.listen(PORT, HOST, () => {
  const link = `http://${HOST}:${PORT}`;
  console.log('');
  console.log('  phantum — Claude Code and Codex terminal manager');
  console.log('  ' + '-'.repeat(38));
  console.log('  open:   ' + link);
  console.log('  config: ' + store.CONFIG_PATH);
  console.log('');
});

function shutdown() {
  console.log('\n[phantum] shutting down…');
  store.flush();
  manager.killAll();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGHUP', shutdown);

module.exports = { app, server };
