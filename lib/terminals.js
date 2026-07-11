'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');
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

function isDir(p) {
  try {
    return !!p && fs.statSync(p).isDirectory();
  } catch (_) {
    return false;
  }
}

// Claude Code stores each project's sessions under ~/.claude/projects/<folder>,
// where <folder> is the working directory with every non-alphanumeric character
// replaced by a dash. `claude --resume <id>` only finds a session when launched
// from a cwd that encodes to the same folder — so a moved/renamed/deleted cwd is
// exactly why a "resume" silently comes back as a brand-new instance.
function encodeProject(cwd) {
  return String(cwd || '').replace(/[^a-zA-Z0-9]/g, '-');
}

function projectsDir() {
  return path.join(os.homedir(), '.claude', 'projects');
}

// Which project folder physically holds <id>.jsonl (or null if it's nowhere).
function findSessionFolder(id) {
  let dirs;
  try {
    dirs = fs.readdirSync(projectsDir());
  } catch (_) {
    return null;
  }
  for (const d of dirs) {
    if (fs.existsSync(path.join(projectsDir(), d, id + '.jsonl'))) return d;
  }
  return null;
}

// The most-recently-modified session id inside a project folder — used to turn a
// blank `--resume` (interactive picker, which comes up empty/fresh on restart)
// into a deterministic resume of the latest conversation for that directory.
function latestSessionId(folder) {
  const dir = path.join(projectsDir(), folder);
  let best = null;
  let bestM = -1;
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.jsonl')) continue;
      const m = fs.statSync(path.join(dir, f)).mtimeMs;
      if (m > bestM) {
        bestM = m;
        best = f.slice(0, -'.jsonl'.length);
      }
    }
  } catch (_) {}
  return best;
}

const RESUME_FLAGS = new Set(['--resume', '-r']);

// Layer working-directory + resume repair on top of the raw command. Returns the
// exact file/args/cwd to spawn plus a human-readable notice and a machine-
// readable `resume` state the UI surfaces so the user can reconcile, instead of
// the old behaviour of silently falling back to $HOME and losing the session.
function resolveLaunch(chat) {
  const { file, args } = resolveCommand(chat);
  const isClaude = (chat.shell || 'claude').trim().toLowerCase() === 'claude';
  const cwdExists = isDir(chat.cwd);
  let cwd = chat.cwd;
  let resume = 'none';
  let warning = '';
  let notice = '';

  // Locate a `--resume` flag (and any explicit id that follows it).
  const ridx = args.findIndex((a) => RESUME_FLAGS.has(a));
  const afterId =
    ridx !== -1 && args[ridx + 1] && !args[ridx + 1].startsWith('-')
      ? args[ridx + 1]
      : null;

  if (!cwdExists) {
    // The configured folder is gone. Launching in $HOME would resume nothing and
    // look like a fresh instance — so say so loudly and disable the doomed resume.
    cwd = os.homedir();
    warning = `Working directory not found: ${chat.cwd}`;
    notice =
      `\r\n\x1b[33m[phantum] ${warning}\r\n` +
      `Launched in ${cwd} instead — edit this chat's folder to restore resume.\x1b[0m\r\n`;
    if (isClaude && ridx !== -1) {
      args.splice(ridx, afterId ? 2 : 1);
      resume = 'cwd-missing';
    }
    return { file, args, cwd, resume, warning, notice };
  }

  if (isClaude && ridx !== -1) {
    if (afterId) {
      const folder = findSessionFolder(afterId);
      if (!folder) {
        warning = `Session ${afterId} not found on disk — started fresh.`;
        notice = `\r\n\x1b[33m[phantum] ${warning}\x1b[0m\r\n`;
        args.splice(ridx, 2);
        resume = 'session-missing';
      } else if (folder !== encodeProject(cwd)) {
        // The session lives under a different folder than this cwd encodes to,
        // so `--resume` will fail and Claude opens fresh. Surface the real home.
        warning =
          `This folder doesn't hold session ${afterId} (it belongs to ${folder}). ` +
          `Resume may fail — check the chat's working directory.`;
        notice = `\r\n\x1b[33m[phantum] ${warning}\x1b[0m\r\n`;
        resume = 'cwd-mismatch';
      } else {
        resume = 'ok';
      }
    } else {
      // Blank `--resume`: pin it to the latest session for this directory so a
      // restart re-enters that conversation instead of an empty picker.
      const latest = latestSessionId(encodeProject(cwd));
      if (latest) {
        args.splice(ridx + 1, 0, latest);
        resume = 'latest';
        notice = `\r\n\x1b[90m[phantum] resuming latest session ${latest}\x1b[0m\r\n`;
      } else {
        args.splice(ridx, 1);
        warning = 'No previous sessions for this folder — started fresh.';
        notice = `\r\n\x1b[33m[phantum] ${warning}\x1b[0m\r\n`;
        resume = 'no-sessions';
      }
    }
  }

  return { file, args, cwd, resume, warning, notice };
}

class Terminal {
  constructor(chat) {
    this.chatId = chat.id;
    this.chat = chat;
    this.buffer = '';
    this.clients = new Set(); // ws connections
    this.exited = false;
    this.exitCode = null;

    const launch = resolveLaunch(chat);
    const { file, args, cwd } = launch;
    // What actually got launched + why — surfaced via the status API so the pane
    // can warn when a resume was repaired, redirected, or couldn't happen.
    this.launch = {
      cwd,
      resume: launch.resume,
      warning: launch.warning || '',
      args
    };
    // A repair notice replays into the pane on attach (shells keep it on screen;
    // Claude clears it, which is why the header badge carries the same warning).
    if (launch.notice) this.buffer = launch.notice;

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

  get info() {
    return {
      status: this.status,
      cwd: this.launch ? this.launch.cwd : this.chat.cwd,
      resume: this.launch ? this.launch.resume : 'none',
      warning: this.launch ? this.launch.warning : ''
    };
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

  // Richer per-chat launch info (status + effective cwd + resume state/warning)
  // so the UI can flag chats whose resume was repaired or couldn't happen.
  infoMap() {
    const out = {};
    for (const [id, t] of this.terminals) out[id] = t.info;
    return out;
  }

  killAll() {
    for (const t of this.terminals.values()) t.kill();
    this.terminals.clear();
  }
}

module.exports = {
  TerminalManager,
  resolveCommand,
  resolveLaunch,
  encodeProject,
  findSessionFolder,
  latestSessionId
};
