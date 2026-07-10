import { Terminal } from '/vendor/xterm/lib/xterm.mjs';
import { FitAddon } from '/vendor/addon-fit/lib/addon-fit.mjs';
import { WebLinksAddon } from '/vendor/addon-web-links/lib/addon-web-links.mjs';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let config = null; // { version, chats, layout, settings }
let runtime = null; // { status, configPath, platform, homedir }
const panes = new Map(); // chatId -> { term, fit, ws, el, resizeObs }
let editingId = null; // chat id when dialog is in edit mode

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

function cryptoId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

const THEME = {
  background: '#000000',
  foreground: '#d7dce5',
  cursor: '#7c9cff',
  cursorAccent: '#000000',
  selectionBackground: 'rgba(124,156,255,0.3)',
  black: '#1a1e29',
  red: '#ff6b6b',
  green: '#3fdd8a',
  yellow: '#ffcf5c',
  blue: '#7c9cff',
  magenta: '#c792ea',
  cyan: '#5ad1e0',
  white: '#d7dce5',
  brightBlack: '#5b6472'
};

// ---------------------------------------------------------------------------
// Config persistence
// ---------------------------------------------------------------------------

// The server's phantum.config.json is the source of truth, but we also mirror
// every save into localStorage as a per-browser backup. If the server file is
// ever lost (moved folder, wiped file) the browser can restore the last setup.
const LS_KEY = 'phantum:config:v1';

function mirrorLocal() {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(config));
  } catch (_) {}
}

async function loadConfig() {
  const res = await fetch('/api/config');
  const data = await res.json();
  runtime = data.runtime;
  delete data.runtime;
  config = data;

  // Recovery: server came up empty but the browser remembers a setup -> restore
  // it and push it back to the server file. (Every mutation mirrors to
  // localStorage, so a genuine "delete all" also empties the mirror — this only
  // fires when the config file itself was lost.)
  if (!config.chats.length) {
    try {
      const local = JSON.parse(localStorage.getItem(LS_KEY) || 'null');
      if (local && Array.isArray(local.chats) && local.chats.length) {
        config = local;
        await saveConfigNow();
      }
    } catch (_) {}
  }
  mirrorLocal();
}

let saveTimer = null;
let savePromise = Promise.resolve();
// Debounced full-config save. Returns a promise that settles when the write
// that includes the current state has been accepted by the server.
function saveConfig() {
  return new Promise((resolve) => {
    if (saveTimer) clearTimeout(saveTimer);
    mirrorLocal();
    saveTimer = setTimeout(async () => {
      saveTimer = null;
      savePromise = fetch('/api/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config)
      })
        .then((r) => r.json())
        .then((data) => {
          runtime = data.runtime;
        })
        .catch((e) => console.error('save failed', e));
      await savePromise;
      resolve();
    }, 120);
  });
}

// Persist immediately (no debounce) and wait for it — used before opening a ws.
async function saveConfigNow() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  mirrorLocal();
  const res = await fetch('/api/config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config)
  });
  const data = await res.json();
  runtime = data.runtime;
}

// ---------------------------------------------------------------------------
// Rendering — sidebar
// ---------------------------------------------------------------------------

function relTime(ts) {
  if (!ts) return '';
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function statusOf(chatId) {
  return (runtime && runtime.status && runtime.status[chatId]) || 'stopped';
}

function renderSidebar() {
  const list = $('#chat-list');
  list.innerHTML = '';
  const open = new Set(config.layout.openChatIds);

  // Most-recently-accessed first.
  const chats = [...config.chats].sort(
    (a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0)
  );

  for (const chat of chats) {
    const isOpen = open.has(chat.id);
    const st = statusOf(chat.id);
    const el = document.createElement('div');
    el.className =
      'chat' +
      (isOpen ? ' open' : '') +
      (config.layout.focusedChatId === chat.id ? ' focused' : '');
    el.dataset.id = chat.id;

    const cmdLabel = shellLabel(chat);
    el.innerHTML = `
      <div class="chat-top">
        <span class="dot ${st}" title="${st}"></span>
        <span class="chat-name"></span>
        <span class="chat-cmd"></span>
      </div>
      <div class="chat-dir" dir="rtl"></div>
      <div class="chat-meta">
        <span class="chat-time">${relTime(chat.lastAccessed)}</span>
        <span class="chat-actions">
          <button class="icon-btn" data-act="edit" title="Edit">✎</button>
          <button class="icon-btn" data-act="restart" title="Restart terminal">⟳</button>
          <button class="icon-btn" data-act="delete" title="Delete">🗑</button>
        </span>
      </div>`;
    const nameEl = el.querySelector('.chat-name');
    nameEl.textContent = chat.name;
    nameEl.title = 'Double-click to rename';
    el.querySelector('.chat-cmd').textContent = cmdLabel;
    el.querySelector('.chat-dir').textContent = chat.cwd;

    let clickTimer = null;
    el.addEventListener('click', (e) => {
      const act = e.target.dataset.act;
      if (act === 'edit') return openDialog(chat);
      if (act === 'delete') return deleteChat(chat.id);
      if (act === 'restart') return restartTerminal(chat.id);
      // Clicking the name: wait a beat to distinguish from a double-click
      // (which opens inline rename). Clicking anywhere else opens immediately.
      if (e.target === nameEl) {
        if (nameEl.querySelector('input') || e.detail > 1) return;
        clearTimeout(clickTimer);
        clickTimer = setTimeout(() => togglePane(chat.id), 200);
        return;
      }
      togglePane(chat.id);
    });
    nameEl.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      clearTimeout(clickTimer);
      inlineRename(chat, nameEl);
    });
    list.appendChild(el);
  }
  updateEmptyState();
}

function shellLabel(chat) {
  const s = (chat.shell || 'claude').toLowerCase();
  if (s === 'claude') return 'claude';
  if (s === 'pwsh' || s === 'powershell') return 'ps';
  if (s === 'cmd') return 'cmd';
  if (s === 'bash') return 'bash';
  return s.split(/[\\/]/).pop();
}

// Turn a name element (sidebar name or pane title) into an inline text field.
// Enter/blur commits, Escape cancels. This is the "really easy" rename path;
// the ✎ button still opens the full edit dialog for dir/command/flags.
function inlineRename(chat, el) {
  if (el.querySelector('input')) return;
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'rename-input';
  input.value = chat.name;
  el.textContent = '';
  el.appendChild(input);
  input.focus();
  input.select();

  let done = false;
  const finish = (save) => {
    if (done) return;
    done = true;
    const val = input.value.trim();
    if (save && val) {
      chat.name = val;
      chat.lastAccessed = Date.now();
      saveConfig();
    }
    const pane = panes.get(chat.id);
    if (pane) pane.el.querySelector('.pane-title').textContent = chat.name;
    renderSidebar();
  };

  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') finish(true);
    else if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
  ['click', 'mousedown', 'dblclick'].forEach((ev) =>
    input.addEventListener(ev, (e) => e.stopPropagation())
  );
}

function refreshChatMeta() {
  // Cheap periodic refresh of status dots + relative times without a full
  // re-render (which would blow away terminal focus).
  for (const el of $$('.chat')) {
    const id = el.dataset.id;
    const chat = config.chats.find((c) => c.id === id);
    if (!chat) continue;
    const dot = el.querySelector('.dot');
    const st = statusOf(id);
    dot.className = 'dot ' + st;
    dot.title = st;
    el.querySelector('.chat-time').textContent = relTime(chat.lastAccessed);
  }
  for (const [id, pane] of panes) {
    const st = statusOf(id);
    const dot = pane.el.querySelector('.dot');
    if (dot) {
      dot.className = 'dot ' + st;
      dot.title = st;
    }
  }
}

function updateEmptyState() {
  const any = config.layout.openChatIds.length > 0;
  $('#empty-state').classList.toggle('hidden', any);
  $('#panes').classList.toggle('hidden', !any);
}

// ---------------------------------------------------------------------------
// Panes + terminals
// ---------------------------------------------------------------------------

function applyColumns() {
  const cols = config.layout.columns || 'auto';
  const grid = $('#panes');
  const n = config.layout.openChatIds.length;
  let css;
  if (cols === 'auto') {
    const perRow = Math.min(Math.max(1, Math.ceil(Math.sqrt(n))), 3);
    css = `repeat(${perRow}, minmax(0, 1fr))`;
  } else {
    css = `repeat(${Math.min(cols, Math.max(1, n))}, minmax(0, 1fr))`;
  }
  grid.style.gridTemplateColumns = css;
  // Give xterm a beat to settle, then refit everything.
  requestAnimationFrame(() => panes.forEach((p) => fitPane(p)));
}

function togglePane(chatId) {
  if (panes.has(chatId)) closePane(chatId);
  else openPane(chatId);
}

async function openPane(chatId) {
  const chat = config.chats.find((c) => c.id === chatId);
  if (!chat || panes.has(chatId)) return;

  if (!config.layout.openChatIds.includes(chatId)) {
    config.layout.openChatIds.push(chatId);
  }
  chat.lastAccessed = Date.now();
  config.layout.focusedChatId = chatId;

  // Make sure the server knows about this chat before we open the socket.
  await saveConfigNow();

  const el = document.createElement('div');
  el.className = 'pane';
  el.dataset.id = chatId;
  el.innerHTML = `
    <div class="pane-head">
      <span class="dot ${statusOf(chatId)}"></span>
      <span class="pane-title"></span>
      <span class="pane-dir" dir="rtl"></span>
      <span class="pane-actions">
        <button class="icon-btn" data-act="restart" title="Restart">⟳</button>
        <button class="icon-btn" data-act="clear" title="Clear">⌫</button>
        <button class="icon-btn" data-act="close" title="Close pane">✕</button>
      </span>
    </div>
    <div class="pane-body"></div>`;
  const titleEl = el.querySelector('.pane-title');
  titleEl.textContent = chat.name;
  titleEl.title = 'Double-click to rename';
  titleEl.addEventListener('dblclick', (e) => {
    e.stopPropagation();
    inlineRename(chat, titleEl);
  });
  el.querySelector('.pane-dir').textContent = chat.cwd;
  $('#panes').appendChild(el);

  const body = el.querySelector('.pane-body');

  const term = new Terminal({
    fontFamily:
      '"Cascadia Code", "JetBrains Mono", Consolas, ui-monospace, monospace',
    fontSize: 13,
    lineHeight: 1.0,
    cursorBlink: true,
    scrollback: 10000,
    allowProposedApi: true,
    theme: THEME
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon());
  term.open(body);
  fit.fit();

  const ws = new WebSocket(
    `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?chatId=${encodeURIComponent(chatId)}`
  );
  ws.binaryType = 'arraybuffer';

  const pane = { term, fit, ws, el, resizeObs: null };
  panes.set(chatId, pane);

  ws.onopen = () => {
    sendResize(pane);
  };
  ws.onmessage = (ev) => {
    let data = ev.data;
    if (data instanceof ArrayBuffer) data = new TextDecoder().decode(data);
    // Control messages from server are JSON with a __phantum marker.
    if (typeof data === 'string' && data.startsWith('{"__phantum"')) {
      try {
        const m = JSON.parse(data);
        if (m.__phantum === 'exit') refreshRuntime();
        return;
      } catch (_) {}
    }
    term.write(data);
  };
  ws.onclose = () => {
    term.write('\r\n\x1b[90m[disconnected]\x1b[0m\r\n');
  };

  // User keystrokes -> pty.
  term.onData((d) => {
    if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'input', data: d }));
  });

  wireKeys(term, ws, pane);

  // Refit on any size change of the pane.
  const ro = new ResizeObserver(() => fitPane(pane));
  ro.observe(body);
  pane.resizeObs = ro;

  el.addEventListener('mousedown', () => focusPane(chatId));
  el.querySelector('.pane-actions').addEventListener('click', (e) => {
    const act = e.target.dataset.act;
    if (act === 'close') closePane(chatId);
    else if (act === 'restart') restartTerminal(chatId);
    else if (act === 'clear') term.clear();
    e.stopPropagation();
  });

  applyColumns();
  renderSidebar();
  focusPane(chatId);
  saveConfig();
  term.focus();
}

function closePane(chatId) {
  const pane = panes.get(chatId);
  if (pane) {
    // Note: we intentionally DON'T kill the pty here — the session keeps
    // running on the server so reopening the pane resumes it. Use the sidebar
    // restart/delete actions to actually stop a process.
    if (pane.resizeObs) pane.resizeObs.disconnect();
    try {
      pane.ws.close();
    } catch (_) {}
    pane.term.dispose();
    pane.el.remove();
    panes.delete(chatId);
  }
  config.layout.openChatIds = config.layout.openChatIds.filter(
    (id) => id !== chatId
  );
  if (config.layout.focusedChatId === chatId) {
    config.layout.focusedChatId = config.layout.openChatIds.at(-1) || null;
  }
  applyColumns();
  renderSidebar();
  saveConfig();
}

function closeAllPanes() {
  for (const id of [...panes.keys()]) closePane(id);
}

function focusPane(chatId) {
  config.layout.focusedChatId = chatId;
  for (const [id, pane] of panes) {
    pane.el.classList.toggle('focused', id === chatId);
  }
  for (const el of $$('.chat')) {
    el.classList.toggle('focused', el.dataset.id === chatId);
  }
}

function fitPane(pane) {
  try {
    pane.fit.fit();
    sendResize(pane);
  } catch (_) {}
}

function sendResize(pane) {
  if (pane.ws.readyState === 1) {
    pane.ws.send(
      JSON.stringify({
        type: 'resize',
        cols: pane.term.cols,
        rows: pane.term.rows
      })
    );
  }
}

// Key handling — this is what makes Claude Code's clipboard/image paste work.
// We forward the raw paste keystrokes straight to the pty so Claude Code
// reads the OS clipboard itself (it runs on the same machine), instead of
// letting the browser swallow the event.
function wireKeys(term, ws, pane) {
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true;

    const key = (e.key || '').toLowerCase();

    // Ctrl+V (no shift) -> raw 0x16. Claude Code intercepts this and reads the
    // clipboard, attaching an image if one is present.
    if (e.ctrlKey && !e.shiftKey && !e.altKey && key === 'v') {
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'input', data: '\x16' }));
      e.preventDefault();
      return false;
    }

    // Alt+V -> ESC v (some Claude Code builds bind image paste here).
    if (e.altKey && !e.ctrlKey && key === 'v') {
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'input', data: '\x1bv' }));
      e.preventDefault();
      return false;
    }

    // Ctrl+Shift+V -> explicit *text* paste (bracketed) as a reliable fallback.
    if (e.ctrlKey && e.shiftKey && key === 'v') {
      navigator.clipboard
        .readText()
        .then((t) => {
          if (t && ws.readyState === 1)
            ws.send(
              JSON.stringify({ type: 'input', data: `\x1b[200~${t}\x1b[201~` })
            );
        })
        .catch(() => {});
      e.preventDefault();
      return false;
    }

    // Ctrl+Shift+C -> copy current selection (Ctrl+C stays SIGINT).
    if (e.ctrlKey && e.shiftKey && key === 'c') {
      const sel = term.getSelection();
      if (sel) navigator.clipboard.writeText(sel).catch(() => {});
      e.preventDefault();
      return false;
    }

    return true;
  });

  // Right-click pastes clipboard text (bracketed) — a familiar terminal habit.
  pane.el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    navigator.clipboard
      .readText()
      .then((t) => {
        if (t && ws.readyState === 1)
          ws.send(
            JSON.stringify({ type: 'input', data: `\x1b[200~${t}\x1b[201~` })
          );
      })
      .catch(() => {});
  });
}

// ---------------------------------------------------------------------------
// Terminal lifecycle actions
// ---------------------------------------------------------------------------

async function restartTerminal(chatId) {
  await fetch(`/api/chats/${chatId}/restart`, { method: 'POST' });
  toast('Terminal restarted');
  // Reopen the socket so the pane attaches to the fresh process.
  const wasOpen = panes.has(chatId);
  if (wasOpen) {
    closePaneSocketOnly(chatId);
    setTimeout(() => reopenSocket(chatId), 150);
  }
  refreshRuntime();
}

function closePaneSocketOnly(chatId) {
  const pane = panes.get(chatId);
  if (!pane) return;
  try {
    pane.ws.close();
  } catch (_) {}
  pane.term.reset();
}

function reopenSocket(chatId) {
  const pane = panes.get(chatId);
  if (!pane) return;
  const ws = new WebSocket(
    `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?chatId=${encodeURIComponent(chatId)}`
  );
  ws.binaryType = 'arraybuffer';
  pane.ws = ws;
  ws.onopen = () => sendResize(pane);
  ws.onmessage = (ev) => {
    let data = ev.data;
    if (data instanceof ArrayBuffer) data = new TextDecoder().decode(data);
    if (typeof data === 'string' && data.startsWith('{"__phantum"')) return;
    pane.term.write(data);
  };
  pane.term.onData((d) => {
    if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'input', data: d }));
  });
}

async function deleteChat(chatId) {
  const chat = config.chats.find((c) => c.id === chatId);
  if (!chat) return;
  if (!confirm(`Delete "${chat.name}"? This kills its terminal too.`)) return;
  if (panes.has(chatId)) closePane(chatId);
  config.chats = config.chats.filter((c) => c.id !== chatId);
  await fetch(`/api/chats/${chatId}`, { method: 'DELETE' }).catch(() => {});
  await saveConfigNow();
  renderSidebar();
  toast('Deleted');
}

// ---------------------------------------------------------------------------
// New / edit dialog
// ---------------------------------------------------------------------------

function openDialog(chat = null) {
  editingId = chat ? chat.id : null;
  $('#dialog-title').textContent = chat ? 'Edit terminal' : 'New terminal';
  $('#dialog-save').textContent = chat ? 'Save' : 'Create';

  $('#f-name').value = chat ? chat.name : '';
  $('#f-cwd').value = chat
    ? chat.cwd
    : config.settings.defaultCwd || runtime.homedir;

  const shell = chat ? chat.shell : config.settings.defaultShell || 'claude';
  const known = ['claude', 'pwsh', 'powershell', 'cmd', 'bash'];
  const sel = $('#f-shell');
  if (known.includes(shell)) {
    sel.value = shell;
    $('#f-custom').value = '';
  } else {
    sel.value = '__custom';
    $('#f-custom').value = shell;
  }

  // Reset flags, then hydrate from existing args.
  $$('#claude-flags input[type=checkbox]').forEach((c) => (c.checked = false));
  $('#f-model').value = '';
  $('#f-resume').value = '';
  const args = chat ? [...chat.args] : [];
  const extra = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--dangerously-skip-permissions') setFlag(a, true);
    else if (a === '--continue' || a === '-c') setFlag('--continue', true);
    else if (a === '--model') {
      setFlag('--model', true);
      $('#f-model').value = args[i + 1] || '';
      i++;
    } else if (a === '--resume' || a === '-r') {
      setFlag('--resume', true);
      // The session id is the next token, unless that's another flag.
      const next = args[i + 1];
      if (next && !next.startsWith('-')) {
        $('#f-resume').value = next;
        i++;
      }
    } else extra.push(a);
  }
  $('#f-args').value = extra.join(' ');

  onShellChange();
  onBrowseToggle(false);
  $('#dialog-backdrop').classList.remove('hidden');
  $('#f-name').focus();
}

function setFlag(flag, val) {
  const cb = $(`#claude-flags input[data-flag="${flag}"]`);
  if (cb) cb.checked = val;
}

function closeDialog() {
  $('#dialog-backdrop').classList.add('hidden');
  editingId = null;
}

function onShellChange() {
  const v = $('#f-shell').value;
  $('#custom-field').classList.toggle('hidden', v !== '__custom');
  $('#claude-flags').classList.toggle('hidden', v !== 'claude');
}

function collectArgs() {
  const args = [];
  if ($('#f-shell').value === 'claude') {
    $$('#claude-flags input[type=checkbox]:checked').forEach((cb) => {
      const flag = cb.dataset.flag;
      if (flag === '--model') {
        const m = $('#f-model').value.trim();
        if (m) args.push('--model', m);
      } else if (flag === '--resume') {
        const id = $('#f-resume').value.trim();
        // With an id -> resume that session; without -> Claude shows a picker.
        if (id) args.push('--resume', id);
        else args.push('--resume');
      } else {
        args.push(flag);
      }
    });
  }
  const extra = $('#f-args').value.trim();
  if (extra) args.push(...extra.match(/(?:[^\s"]+|"[^"]*")+/g).map((s) => s.replace(/"/g, '')));
  return args;
}

async function saveDialog() {
  const name = $('#f-name').value.trim() || 'terminal';
  const cwd = $('#f-cwd').value.trim() || runtime.homedir;
  let shell = $('#f-shell').value;
  if (shell === '__custom') shell = $('#f-custom').value.trim() || 'cmd';
  const args = collectArgs();

  if (editingId) {
    const chat = config.chats.find((c) => c.id === editingId);
    Object.assign(chat, { name, cwd, shell, args });
    // Remember defaults for next time.
    config.settings.defaultShell = shell;
    config.settings.defaultCwd = cwd;
    await saveConfigNow();
    renderSidebar();
    // If open, refresh the pane header (process keeps running until restart).
    const pane = panes.get(editingId);
    if (pane) {
      pane.el.querySelector('.pane-title').textContent = name;
      pane.el.querySelector('.pane-dir').textContent = cwd;
    }
    toast('Saved — restart the terminal to apply command/dir changes');
  } else {
    const chat = {
      id: cryptoId(),
      name,
      cwd,
      shell,
      args,
      createdAt: Date.now(),
      lastAccessed: Date.now()
    };
    config.chats.push(chat);
    config.settings.defaultShell = shell;
    config.settings.defaultCwd = cwd;
    await saveConfigNow();
    renderSidebar();
    openPane(chat.id);
    toast('Terminal created');
  }
  closeDialog();
}

// ---- folder browser ----
let browserDir = null;
async function onBrowseToggle(show) {
  const box = $('#browser');
  if (show === false) {
    box.classList.add('hidden');
    return;
  }
  const hidden = box.classList.contains('hidden');
  if (hidden) {
    box.classList.remove('hidden');
    await loadBrowser($('#f-cwd').value.trim() || '~');
  } else {
    box.classList.add('hidden');
  }
}

async function loadBrowser(dir) {
  try {
    const res = await fetch('/api/fs?path=' + encodeURIComponent(dir));
    const data = await res.json();
    if (data.error) return toast(data.error, 'bad');
    browserDir = data.dir;
    $('#browser-path').textContent = data.dir;
    const list = $('#browser-list');
    list.innerHTML = '';
    const useHere = document.createElement('div');
    useHere.className = 'browser-item up';
    useHere.textContent = '✓ Use this folder';
    useHere.addEventListener('click', () => {
      $('#f-cwd').value = data.dir;
      onBrowseToggle(false);
    });
    list.appendChild(useHere);
    if (data.parent) {
      const up = document.createElement('div');
      up.className = 'browser-item up';
      up.textContent = '📁 ..';
      up.addEventListener('click', () => loadBrowser(data.parent));
      list.appendChild(up);
    }
    for (const e of data.entries) {
      const item = document.createElement('div');
      item.className = 'browser-item';
      item.textContent = '📁 ' + e.name;
      item.addEventListener('click', () => loadBrowser(e.path));
      list.appendChild(item);
    }
  } catch (err) {
    toast('Cannot read folder', 'bad');
  }
}

// ---------------------------------------------------------------------------
// Config import / export / save-as / load
// ---------------------------------------------------------------------------

function exportConfig() {
  window.location.href = '/api/config/export';
  toast('Config downloaded');
}

// "Save config as…" — same JSON, lets the user stash a named snapshot.
function saveConfigAs() {
  const blob = new Blob([JSON.stringify(config, null, 2)], {
    type: 'application/json'
  });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  const stamp = new Date()
    .toISOString()
    .slice(0, 19)
    .replace(/[:T]/g, '-');
  a.download = `phantum-config-${stamp}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  toast('Snapshot saved');
}

function importConfigDialog() {
  $('#import-file').click();
}

async function onImportFile(e) {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const incoming = JSON.parse(text);
    if (!incoming || !Array.isArray(incoming.chats))
      throw new Error('not a phantum config');
    closeAllPanes();
    config = incoming;
    await saveConfigNow();
    await bootFromConfig();
    toast('Config loaded');
  } catch (err) {
    toast('Invalid config: ' + err.message, 'bad');
  } finally {
    e.target.value = '';
  }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function bootFromConfig() {
  renderSidebar();
  setColumnsUI(config.layout.columns || 'auto');
  $('#config-path').textContent = runtime.configPath;
  // Re-open panes that were open last session (fresh terminals — old ptys
  // died with the previous server process, which is expected).
  const toOpen = [...config.layout.openChatIds];
  config.layout.openChatIds = [];
  for (const id of toOpen) {
    if (config.chats.find((c) => c.id === id)) await openPane(id);
  }
  if (config.layout.focusedChatId) focusPane(config.layout.focusedChatId);
  updateEmptyState();
}

async function refreshRuntime() {
  try {
    const res = await fetch('/api/status');
    const data = await res.json();
    if (runtime) runtime.status = data.status;
    refreshChatMeta();
  } catch (_) {}
}

function setColumnsUI(cols) {
  $$('#layout-controls .seg-btn').forEach((b) =>
    b.classList.toggle('active', b.dataset.cols === String(cols))
  );
}

function toast(msg, kind = 'good') {
  const t = $('#toast');
  t.textContent = msg;
  t.className = kind;
  t.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add('hidden'), 2600);
}

// ---------------------------------------------------------------------------
// Wire up static UI
// ---------------------------------------------------------------------------

function wireUI() {
  $('#btn-new').addEventListener('click', () => openDialog());
  $('#empty-new').addEventListener('click', () => openDialog());

  // Config menu
  const menu = $('#config-menu');
  $('#btn-config').addEventListener('click', (e) => {
    e.stopPropagation();
    menu.classList.toggle('hidden');
  });
  document.addEventListener('click', () => menu.classList.add('hidden'));
  menu.addEventListener('click', (e) => {
    const act = e.target.dataset.action;
    if (act === 'save-config') saveConfigAs();
    else if (act === 'export-config') exportConfig();
    else if (act === 'import-config') importConfigDialog();
    else if (act === 'close-all') closeAllPanes();
    menu.classList.add('hidden');
  });

  // Columns
  $$('#layout-controls .seg-btn').forEach((b) =>
    b.addEventListener('click', () => {
      const v = b.dataset.cols;
      config.layout.columns = v === 'auto' ? 'auto' : Number(v);
      setColumnsUI(v);
      applyColumns();
      saveConfig();
    })
  );

  // Dialog
  $('#dialog-cancel').addEventListener('click', closeDialog);
  $('#dialog-save').addEventListener('click', saveDialog);
  $('#f-shell').addEventListener('change', onShellChange);
  $('#f-browse').addEventListener('click', () => onBrowseToggle());
  $('#dialog-backdrop').addEventListener('click', (e) => {
    if (e.target.id === 'dialog-backdrop') closeDialog();
  });
  $('#import-file').addEventListener('change', onImportFile);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#dialog-backdrop').classList.contains('hidden'))
      closeDialog();
  });

  // Refit terminals when the window resizes.
  window.addEventListener('resize', () => panes.forEach((p) => fitPane(p)));

  // On close/refresh/shutdown, flush the very latest layout so reopening always
  // lands on your last setup. sendBeacon survives page teardown; localStorage is
  // the local backup.
  window.addEventListener('pagehide', flushOnExit);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushOnExit();
  });
}

function flushOnExit() {
  try {
    mirrorLocal();
    const blob = new Blob([JSON.stringify(config)], {
      type: 'application/json'
    });
    navigator.sendBeacon('/api/config', blob);
  } catch (_) {}
}

async function main() {
  wireUI();
  await loadConfig();
  await bootFromConfig();
  setInterval(refreshRuntime, 4000);
  setInterval(refreshChatMeta, 15000);
}

main();
