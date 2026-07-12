'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

// Config lives next to the app by default so it "comes right back up" after a
// restart. Can be overridden with PHANTUM_CONFIG for portable / shared setups.
const CONFIG_PATH =
  process.env.PHANTUM_CONFIG ||
  path.join(__dirname, '..', 'phantum.config.json');

const CONFIG_VERSION = 1;

function defaultConfig() {
  return {
    version: CONFIG_VERSION,
    chats: [],
    layout: {
      openChatIds: [],
      columns: 'auto', // 'auto' | 1 | 2 | 3 | 4
      focusedChatId: null,
      sidebarWidth: 288, // px width of the left panel
      sidebarCollapsed: false
    },
    settings: {
      defaultShell: 'claude',
      defaultCwd: os.homedir()
    }
  };
}

function normalize(config) {
  const base = defaultConfig();
  if (!config || typeof config !== 'object') return base;

  const out = {
    version: CONFIG_VERSION,
    chats: Array.isArray(config.chats) ? config.chats.map(normalizeChat) : [],
    layout: { ...base.layout, ...(config.layout || {}) },
    settings: { ...base.settings, ...(config.settings || {}) }
  };

  // Drop open/focused references to chats that no longer exist.
  const ids = new Set(out.chats.map((c) => c.id));
  out.layout.openChatIds = (out.layout.openChatIds || []).filter((id) =>
    ids.has(id)
  );
  if (!ids.has(out.layout.focusedChatId)) out.layout.focusedChatId = null;
  return out;
}

function normalizeChat(c) {
  return {
    id: String(c.id || cryptoId()),
    name: String(c.name || 'terminal'),
    cwd: String(c.cwd || os.homedir()),
    shell: String(c.shell || 'claude'), // 'claude' | 'codex' | 'pwsh' | 'cmd' | custom exe
    args: Array.isArray(c.args) ? c.args.map(String) : [],
    color: c.color || null,
    // Stable Claude session id so resume survives a full restart (assigned by
    // the server for Claude chats). Preserved verbatim; never generated here.
    sessionId: c.sessionId ? String(c.sessionId) : null,
    createdAt: Number(c.createdAt) || Date.now(),
    lastAccessed: Number(c.lastAccessed) || Date.now()
  };
}

function cryptoId() {
  return (
    Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
  );
}

function load() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    return normalize(JSON.parse(raw));
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error('[phantum] failed to read config, starting fresh:', err.message);
    }
    return defaultConfig();
  }
}

let writeTimer = null;
let pending = null;
let lastBackup = 0;

// Keep a couple of time-spaced backups of the on-disk config before overwriting
// it, so an accidental clobber (e.g. a stale browser tab saving an old state) is
// always recoverable. Spaced so rapid autosaves don't churn the good history out.
function backupBeforeWrite() {
  try {
    if (!fs.existsSync(CONFIG_PATH)) return;
    const now = Date.now();
    const bak = CONFIG_PATH + '.bak';
    if (fs.existsSync(bak) && now - lastBackup < 5 * 60 * 1000) return;
    if (fs.existsSync(bak)) {
      try {
        fs.copyFileSync(bak, CONFIG_PATH + '.bak2');
      } catch (_) {}
    }
    fs.copyFileSync(CONFIG_PATH, bak);
    lastBackup = now;
  } catch (_) {}
}

// Debounced, atomic write. The UI autosaves aggressively (on every layout
// change) so we coalesce writes and swap via a temp file to avoid corruption.
function save(config) {
  pending = normalize(config);
  if (writeTimer) return pending;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    const data = pending;
    pending = null;
    try {
      backupBeforeWrite();
      const tmp = CONFIG_PATH + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
      fs.renameSync(tmp, CONFIG_PATH);
    } catch (err) {
      console.error('[phantum] failed to write config:', err.message);
    }
  }, 250);
  return pending;
}

// Force a synchronous flush (used on shutdown).
function flush() {
  if (writeTimer) {
    clearTimeout(writeTimer);
    writeTimer = null;
  }
  if (!pending) return;
  try {
    backupBeforeWrite();
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(pending, null, 2));
  } catch (err) {
    console.error('[phantum] flush failed:', err.message);
  }
  pending = null;
}

module.exports = {
  CONFIG_PATH,
  CONFIG_VERSION,
  defaultConfig,
  normalize,
  normalizeChat,
  cryptoId,
  load,
  save,
  flush
};
