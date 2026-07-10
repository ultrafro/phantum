'use strict';

const os = require('os');
const fs = require('fs');
const pty = require('node-pty');

const isWindows = process.platform === 'win32';

// How much recent output to keep per terminal so a reconnecting browser can
// replay the screen. ~256KB is plenty for a full-screen TUI plus history.
const SCROLLBACK_LIMIT = 256 * 1024;

/**
 * Resolve a chat's `shell` field into an actual command + args.
 *
 * Recognized shortcuts:
 *   'claude' -> the Claude Code CLI (via its shim on PATH)
 *   'pwsh'   -> PowerShell 7 (falls back handled by PATH lookup)
 *   'powershell' -> Windows PowerShell 5
 *   'cmd'    -> cmd.exe
 *   'bash'   -> bash (Git Bash / WSL front shim)
 * Anything else is treated as a literal executable name/path.
 *
 * The chat's `args` are appended verbatim, so flags like
 * `--dangerously-skip-permissions` just work.
 */
function resolveCommand(chat) {
  const shell = (chat.shell || 'claude').trim();
  const extra = Array.isArray(chat.args) ? chat.args.slice() : [];

  switch (shell.toLowerCase()) {
    case 'claude':
      // On Windows `claude` is installed as claude.cmd / claude.ps1. We launch
      // it through cmd.exe so PATHEXT resolution finds the shim reliably, then
      // hand over the flags.
      if (isWindows) {
        return { file: 'cmd.exe', args: ['/c', 'claude', ...extra] };
      }
      return { file: 'claude', args: extra };

    case 'pwsh':
      return { file: 'pwsh.exe', args: ['-NoLogo', ...extra] };

    case 'powershell':
      return {
        file: 'powershell.exe',
        args: ['-NoLogo', '-NoExit', ...extra]
      };

    case 'cmd':
      return { file: 'cmd.exe', args: extra };

    case 'bash':
      return { file: 'bash.exe', args: extra };

    default:
      // Custom executable path/name.
      return { file: shell, args: extra };
  }
}

// Resolve a usable working directory, falling back to home if the configured
// one doesn't exist (a bad path would otherwise fail the spawn with a cryptic
// Windows error code 267 / ERROR_DIRECTORY).
function safeCwd(cwd) {
  try {
    if (cwd && fs.statSync(cwd).isDirectory()) return cwd;
  } catch (_) {}
  return os.homedir();
}

class Terminal {
  constructor(chat) {
    this.chatId = chat.id;
    this.chat = chat;
    this.buffer = '';
    this.clients = new Set(); // ws connections
    this.exited = false;
    this.exitCode = null;

    const { file, args } = resolveCommand(chat);
    const cwd = safeCwd(chat.cwd);

    // A bad executable or environment can make pty.spawn throw. Contain it so a
    // single misconfigured chat can never take down the whole server — surface
    // the failure inside the pane instead.
    try {
      this.proc = pty.spawn(file, args, {
        name: 'xterm-256color',
        cols: chat.cols || 120,
        rows: chat.rows || 30,
        cwd,
        env: process.env,
        // ConPTY is the default backend on win32 and gives full fidelity.
        useConpty: isWindows ? true : undefined
      });
    } catch (err) {
      this.exited = true;
      this.exitCode = -1;
      this.buffer =
        `\r\n\x1b[31m[phantum] failed to launch \x1b[1m${file} ${args.join(' ')}\x1b[0m\r\n` +
        `\x1b[31m[phantum] cwd: ${cwd}\x1b[0m\r\n` +
        `\x1b[90m${String(err && err.message)}\r\n` +
        `Check the command and working directory, then edit the chat and restart.\x1b[0m\r\n`;
      return;
    }

    this.proc.onData((data) => {
      this._appendBuffer(data);
      for (const ws of this.clients) {
        if (ws.readyState === 1) ws.send(data);
      }
    });

    this.proc.onExit(({ exitCode }) => {
      this.exited = true;
      this.exitCode = exitCode;
      const notice = `\r\n\x1b[90m[process exited with code ${exitCode} — press the restart button to relaunch]\x1b[0m\r\n`;
      this._appendBuffer(notice);
      for (const ws of this.clients) {
        if (ws.readyState === 1) {
          ws.send(notice);
          try {
            ws.send(JSON.stringify({ __phantum: 'exit', code: exitCode }));
          } catch (_) {}
        }
      }
    });
  }

  _appendBuffer(data) {
    this.buffer += data;
    if (this.buffer.length > SCROLLBACK_LIMIT) {
      this.buffer = this.buffer.slice(this.buffer.length - SCROLLBACK_LIMIT);
    }
  }

  attach(ws) {
    this.clients.add(ws);
    // Replay recent output so a reconnecting client sees the current screen.
    if (this.buffer && ws.readyState === 1) ws.send(this.buffer);
  }

  detach(ws) {
    this.clients.delete(ws);
  }

  write(data) {
    if (!this.exited && this.proc) this.proc.write(data);
  }

  resize(cols, rows) {
    if (this.exited || !this.proc) return;
    if (cols > 0 && rows > 0) {
      try {
        this.proc.resize(cols, rows);
      } catch (_) {}
    }
  }

  kill() {
    try {
      if (this.proc) this.proc.kill();
    } catch (_) {}
  }

  get status() {
    return this.exited ? 'exited' : 'running';
  }
}

class TerminalManager {
  constructor() {
    this.terminals = new Map(); // chatId -> Terminal
  }

  get(chatId) {
    return this.terminals.get(chatId);
  }

  isRunning(chatId) {
    const t = this.terminals.get(chatId);
    return !!t && !t.exited;
  }

  // Get an existing live terminal or spawn a fresh one for this chat.
  ensure(chat) {
    let t = this.terminals.get(chat.id);
    if (t && !t.exited) return t;
    t = new Terminal(chat);
    this.terminals.set(chat.id, t);
    return t;
  }

  restart(chat) {
    const existing = this.terminals.get(chat.id);
    if (existing) existing.kill();
    const t = new Terminal(chat);
    this.terminals.set(chat.id, t);
    return t;
  }

  kill(chatId) {
    const t = this.terminals.get(chatId);
    if (t) {
      t.kill();
      this.terminals.delete(chatId);
    }
  }

  statusMap() {
    const out = {};
    for (const [id, t] of this.terminals) out[id] = t.status;
    return out;
  }

  killAll() {
    for (const t of this.terminals.values()) t.kill();
    this.terminals.clear();
  }
}

module.exports = { TerminalManager, resolveCommand };
