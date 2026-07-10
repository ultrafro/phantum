#!/usr/bin/env node
'use strict';

const http = require('http');
const path = require('path');
const os = require('os');
const fs = require('fs');
const url = require('url');
const express = require('express');
const { WebSocketServer } = require('ws');

const store = require('./lib/store');
const { TerminalManager } = require('./lib/terminals');

const PORT = Number(process.env.PORT || process.env.PHANTUM_PORT || 7333);
const HOST = process.env.PHANTUM_HOST || '127.0.0.1';

const app = express();
app.use(express.json({ limit: '4mb' }));

const manager = new TerminalManager();
let config = store.load();

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

function withStatus(cfg) {
  const status = manager.statusMap();
  return {
    ...cfg,
    runtime: {
      status,
      configPath: store.CONFIG_PATH,
      platform: process.platform,
      homedir: os.homedir()
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
  config = store.normalize(req.body);
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
  res.json({ status: manager.statusMap() });
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
  console.log('  phantum — Claude Code terminal manager');
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
