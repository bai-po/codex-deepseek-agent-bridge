import {legacyResultView} from './read-policy.mjs';
// DSH -> Codex local task channel (protocol v1, section 3).
//
// Zero dependencies, ESM, Node built-ins only.
//
// Public API (used by dsh-plugin/index.js):
//   createCodexClient({ codexBin?, cwd?, logDir?, resumeTimeoutMs? })
//   client.listThreads({ cwd?, limit?, all? }) -> Promise<Thread[]>
//   client.send({ threadId, message, title?, cwd?, delivery?, timeoutMs? }) -> Promise<TaskHandle>
//   client.wait({ taskId, waitMs? }) -> Promise<TaskSnapshot>
//   client.status({ taskId }) -> Promise<TaskSnapshot>
//   client.cancel({ taskId }) -> Promise<TaskSnapshot>
//
// Implementation notes:
// - `codex exec resume` is spawned with stdio pipes; the task text is written
//   to stdin as UTF-8. stdout is treated as JSONL and decoded with a Buffer
//   based line decoder (multi-byte code points may straddle chunk borders).
// - One resume child per Codex thread at a time; conflicts throw
//   code === 'codex/thread-busy'.
// - Task state is persisted under
//   ~/.dsh/agent-bridge/codex-tasks/<taskId>/{meta.json,events.jsonl,reply.txt}
//   so a restarted plugin can still answer status()/wait() for finished tasks.
// - All errors are plain Error objects with a stable `code` property
//   ('codex/timeout', 'codex/thread-busy', ...). Message bodies are never
//   written to an audit trail by this module (events.jsonl is task-local).

import { spawn as nodeSpawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const DEFAULT_RESUME_TIMEOUT_MS = 900_000; // 15 min
const DEFAULT_QUEUE_TIMEOUT_MS = 60_000;
const DEFAULT_WAIT_MS = 60_000;
const MAX_WAIT_MS = 120_000;
const POLL_INTERVAL_MS = 250;
const STDERR_KEEP = 2_000;
const SESSION_META_MAX_BYTES = 1 * 1024 * 1024;
const LIST_CONCURRENCY = 8;
const MAX_TERMINAL_TASKS = 100;

const TERMINAL_STATES = new Set(['done', 'error']);

function bridgeError(code, message, extra) {
  const err = new Error(message);
  err.code = code;
  if (extra) Object.assign(err, extra);
  return err;
}

function isTerminal(state) {
  return TERMINAL_STATES.has(state);
}

function clampWait(ms) {
  const n = Number.isFinite(ms) ? Math.trunc(ms) : DEFAULT_WAIT_MS;
  return Math.min(Math.max(n, 0), MAX_WAIT_MS);
}

function makeTaskId() {
  return `cx_${Date.now().toString(36)}_${crypto.randomBytes(5).toString('hex')}`;
}

function tail(text, max = STDERR_KEEP) {
  if (!text) return '';
  return text.length <= max ? text : text.slice(text.length - max);
}

function asIsoString(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function normalizePathForCompare(p) {
  if (!p) return '';
  let out = String(p).replace(/\//g, '\\');
  out = out.replace(/^\\\\\?\\/, '');
  out = out.replace(/\\+$/, '');
  return out.toLowerCase();
}

function safeTaskDirName(taskId) {
  return typeof taskId === 'string' && /^[A-Za-z0-9._-]+$/.test(taskId) && !taskId.includes('..');
}

function isFileSync(p) {
  try {
    return fsSync.statSync(p).isFile();
  } catch {
    return false;
  }
}

// Resolve the codex CLI: explicit option -> PATH -> known install roots.
// Returns null when nothing is found; send() then fails with codex/bin-not-found.
export function resolveCodexBin(explicit) {
  const seen = new Set();
  const candidates = [];
  const add = (p) => {
    if (!p) return;
    const key = path.resolve(p).toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push(p);
  };

  if (explicit) {
    add(explicit);
    // An explicit directory option: look for codex.exe inside it.
    try {
      if (fsSync.statSync(explicit).isDirectory()) add(path.join(explicit, 'codex.exe'));
    } catch {
      /* ignore */
    }
  }

  const pathExts = (process.env.PATHEXT || '.EXE;.CMD;.BAT')
    .split(';')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  // We can only spawn real executables without a shell; .exe and extensionless
  // binaries are accepted (the known install ships codex.exe).
  const exts = ['.exe', ...pathExts.filter((e) => e !== '.cmd' && e !== '.bat' && e !== '.exe'), ''];
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) add(path.join(dir, `codex${ext}`));
  }

  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const installRoots = [
    path.join(localAppData, 'OpenAI', 'Codex', 'bin'),
    path.join(os.homedir(), 'AppData', 'Local', 'OpenAI', 'Codex', 'bin'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Codex', 'bin'),
  ];
  for (const root of installRoots) {
    let versions = [];
    try {
      versions = fsSync.readdirSync(root).sort().reverse();
    } catch {
      continue;
    }
    for (const version of versions) add(path.join(root, version, 'codex.exe'));
    add(path.join(root, 'codex.exe'));
  }

  for (const candidate of candidates) {
    if (isFileSync(candidate)) return candidate;
  }
  return null;
}

// ---------------------------------------------------------------------------
// JSONL line decoding (Buffer based so UTF-8 code points may span chunks)
// ---------------------------------------------------------------------------

export class LineDecoder {
  constructor(maxLineBytes = 8 * 1024 * 1024) {
    this.maxLineBytes = maxLineBytes;
    this.buffer = Buffer.alloc(0);
    this.overflowLine = null;
  }

  /** Feed a raw Buffer chunk; returns every complete line decoded as UTF-8. */
  push(chunk) {
    if (!chunk || chunk.length === 0) return [];
    this.buffer = this.buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.buffer, chunk]);
    const lines = [];
    let index;
    while ((index = this.buffer.indexOf(0x0a)) !== -1) {
      let line = this.buffer.subarray(0, index);
      this.buffer = this.buffer.subarray(index + 1);
      if (line.length > 0 && line[line.length - 1] === 0x0d) {
        line = line.subarray(0, line.length - 1);
      }
      lines.push(line.toString('utf8'));
    }
    if (this.buffer.length > this.maxLineBytes) {
      // Defensive: never balloon memory on a pathological stream.
      this.overflowLine = this.buffer.toString('utf8');
      this.buffer = Buffer.alloc(0);
    }
    return lines;
  }

  /** Anything left after the stream ended (no trailing newline). */
  flush() {
    if (this.overflowLine) {
      const line = this.overflowLine;
      this.overflowLine = null;
      return line;
    }
    if (this.buffer.length === 0) return null;
    const line = this.buffer.toString('utf8');
    this.buffer = Buffer.alloc(0);
    return line;
  }
}

/**
 * Parse one line of `codex exec --json` output.
 * Returns null for blank/unparseable lines, otherwise the event object with
 * a `.parseError:true` marker when JSON parsing failed.
 */
export function parseCodexEvent(line) {
  if (typeof line !== 'string') return null;
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const value = JSON.parse(trimmed);
    return value && typeof value === 'object' ? value : null;
  } catch {
    return { type: 'client/parse-error', raw: tail(trimmed, 500), parseError: true };
  }
}

// ---------------------------------------------------------------------------
// Filesystem helpers
// ---------------------------------------------------------------------------

/** Read only the first line of a file, streaming so huge rollouts stay cheap. */
function readFirstLine(filePath, maxBytes = SESSION_META_MAX_BYTES) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      stream.destroy();
      resolve(value);
    };
    const stream = createReadStream(filePath, { highWaterMark: 64 * 1024 });
    let accumulated = Buffer.alloc(0);
    stream.on('data', (chunk) => {
      accumulated = Buffer.concat([accumulated, chunk]);
      const newline = accumulated.indexOf(0x0a);
      if (newline !== -1) finish(accumulated.subarray(0, newline).toString('utf8'));
      else if (accumulated.length >= maxBytes) finish(accumulated.toString('utf8'));
    });
    stream.on('error', () => finish(null));
    stream.on('end', () => finish(accumulated.length ? accumulated.toString('utf8') : null));
  });
}

async function collectRolloutFiles(root) {
  const files = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && /^rollout-.*\.jsonl$/i.test(entry.name)) files.push(full);
    }
  }
  return files;
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

function threadIdFromFilename(filePath) {
  const base = path.basename(filePath);
  // rollout-<ISO>-<uuid>[_<uuid>].jsonl ; the last UUID is the rollout's own thread.
  const uuids = base.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) || [];
  return uuids.length > 0 ? uuids[uuids.length - 1].toLowerCase() : null;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export function createCodexClient(options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const codexHome = opts.codexHome || path.join(os.homedir(), '.codex');
  const config = {
    codexBin: opts.codexBin !== undefined ? opts.codexBin : resolveCodexBin(null),
    cwd: opts.cwd ? path.resolve(opts.cwd) : process.cwd(),
    logDir: path.resolve(opts.logDir || path.join(os.homedir(), '.dsh', 'agent-bridge', 'codex-tasks')),
    sessionsDir: path.resolve(opts.sessionsDir || path.join(codexHome, 'sessions')),
    indexFile: path.resolve(opts.indexFile || path.join(codexHome, 'session_index.jsonl')),
    resumeTimeoutMs: Number.isFinite(opts.resumeTimeoutMs) ? opts.resumeTimeoutMs : DEFAULT_RESUME_TIMEOUT_MS,
    queueTimeoutMs: Number.isFinite(opts.queueTimeoutMs) ? opts.queueTimeoutMs : DEFAULT_QUEUE_TIMEOUT_MS,
    spawn: typeof opts.spawn === 'function' ? opts.spawn : nodeSpawn,
  };

  if (!config.codexBin) {
    // Re-probe once with the known install layout so `createCodexClient()` is
    // forgiving when the binary appears after the module was imported.
    config.codexBin = resolveCodexBin(null);
  }

  const tasks = new Map(); // taskId -> task
  const threadLocks = new Map(); // threadId -> taskId

  function releaseLock(task) {
    if (!task || task.delivery !== 'resume') return;
    if (threadLocks.get(task.threadId) === task.taskId) threadLocks.delete(task.threadId);
  }

  async function persistMeta(task) {
    const meta = {
      taskId: task.taskId,
      threadId: task.threadId,
      delivery: task.delivery,
      state: task.state,
      cwd: task.cwd,
      codexBin: task.codexBin || null,
      pid: task.pid || null,
      startedAt: task.startedAt,
      updatedAt: task.updatedAt,
      request: { message: task.message, title: task.title ?? null },
      reply: task.reply,
      turnEnd: task.turnEnd,
      usage: task.usage,
      note: task.note,
      warnings: task.warnings,
      error: task.error,
    };
    const body = `${JSON.stringify(meta, null, 2)}\n`;
    task.persistChain = (task.persistChain || Promise.resolve())
      .then(async () => { await fs.writeFile(task.metaPath, body, 'utf8'); await fs.writeFile(path.join(task.taskDir,'status.json'), JSON.stringify(legacyResultView(task,false)), 'utf8'); })
      .catch((err) => {
        task.ioErrors.push(`meta: ${err.message}`);
      });
    return task.persistChain;
  }

  function appendEvents(task, payload) {
    const line = typeof payload === 'string' ? payload : JSON.stringify(payload);
    task.eventsChain = (task.eventsChain || Promise.resolve())
      .then(() => fs.appendFile(task.eventsPath, `${line}\n`, 'utf8'))
      .catch((err) => {
        task.ioErrors.push(`events: ${err.message}`);
      });
    return task.eventsChain;
  }

  async function finish(task, state, patch = {}) {
    if (task.settled) return;
    task.settled = true;
    if (patch && typeof patch === 'object') Object.assign(task, patch);
    task.state = state;
    task.updatedAt = new Date().toISOString();
    if (task.timer) {
      clearTimeout(task.timer);
      task.timer = null;
    }
    releaseLock(task);
    try {
      await task.eventsChain;
    } catch {
      /* already recorded in ioErrors */
    }
    try {
      await fs.writeFile(task.replyPath, task.reply || '', 'utf8');
    } catch (err) {
      task.ioErrors.push(`reply: ${err.message}`);
    }
    await persistMeta(task);
    try {
      task.resolveFinal?.();
    } catch {
      /* ignore */
    }
    task.emitter.emit('settle');
  }

  function fail(task, error, extra = {}) {
    const code = error && error.code ? error.code : 'codex/error';
    const message = (error && error.message) || 'codex task failed';
    const errorPayload = { code, message, ...extra };
    if (task.stderrTail) errorPayload.stderr = tail(task.stderrTail, STDERR_KEEP);
    appendEvents(task, { type: 'client/failed', code, message, at: new Date().toISOString() });
    return finish(task, 'error', { error: errorPayload });
  }

  function killTree(task) {
    const child = task.child;
    if (!child) return;
    const pid = child.pid;
    if (process.platform === 'win32' && pid) {
      try {
        const killer = nodeSpawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore',
        });
        killer.on('error', () => {});
      } catch {
        /* fall through to child.kill */
      }
    }
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }

  function handleCodexEvent(task, rawLine) {
    appendEvents(task, rawLine);
    const event = parseCodexEvent(rawLine);
    if (!event) return;
    if (event.parseError) {
      task.parseErrors += 1;
      return;
    }
    if (task.settled) return;
    switch (event.type) {
      case 'thread.started': {
        if (typeof event.thread_id === 'string' && event.thread_id) {
          task.codexThreadId = event.thread_id;
        }
        break;
      }
      case 'turn.started': {
        if (task.state !== 'running') {
          task.state = 'running';
          task.updatedAt = new Date().toISOString();
          void persistMeta(task);
        }
        break;
      }
      case 'item.completed': {
        const item = event.item;
        if (!item || typeof item !== 'object') break;
        if (item.type === 'agent_message' && typeof item.text === 'string') {
          task.reply = item.text; // last agent message wins
        } else if (item.type === 'error') {
          // Codex reports non-fatal warnings (e.g. unrecognized config keys) as
          // error *items* while the turn keeps running: record, never fail.
          task.warnings.push({ at: new Date().toISOString(), message: item.message || 'codex warning' });
        }
        break;
      }
      case 'turn.completed': {
        task.usage = event.usage && typeof event.usage === 'object' ? event.usage : {};
        task.turnEnd = { reason: 'completed', at: new Date().toISOString() };
        void finish(task, 'done');
        break;
      }
      case 'turn.failed': {
        const message =
          (event.error && event.error.message) ||
          event.message ||
          (typeof event.error === 'string' ? event.error : 'codex turn failed');
        void fail(task, bridgeError('codex/turn-failed', message));
        break;
      }
      case 'error': {
        // Top-level error event is fatal (item-level errors are warnings).
        const message =
          (event.error && event.error.message) ||
          event.message ||
          (typeof event.error === 'string' ? event.error : 'codex reported an error');
        void fail(task, bridgeError('codex/turn-failed', message));
        break;
      }
      default:
        break;
    }
  }

  async function startResume(task) {
    const bin = task.codexBin || config.codexBin;
    if (!bin) {
      return fail(
        task,
        bridgeError(
          'codex/bin-not-found',
          'codex CLI not found: pass options.codexBin or put codex.exe on PATH',
        ),
      );
    }
    // NOTE: -C belongs to `codex exec` (parent); current CLI rejects it after
    // the `resume` subcommand, so it must precede `resume`. The child process
    // also starts in task.cwd as a second layer of cwd control.
    const args = ['exec'];
    if (task.cwd) args.push('-C', task.cwd);
    args.push('resume', task.threadId, '--json', '--skip-git-repo-check', '-');

    let child;
    try {
      child = config.spawn(bin, args, {
        cwd: task.cwd || config.cwd,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      return fail(task, bridgeError('codex/spawn-failed', `failed to spawn codex: ${err.message}`));
    }
    task.child = child;
    task.pid = child.pid || null;
    task.spawnedAt = new Date().toISOString();
    void persistMeta(task);

    const decoder = new LineDecoder();
    child.stdout?.on('data', (chunk) => {
      let lines;
      try {
        lines = decoder.push(chunk);
      } catch (err) {
        task.ioErrors.push(`stdout-decode: ${err.message}`);
        return;
      }
      for (const line of lines) handleCodexEvent(task, line);
    });
    child.stdout?.on('error', (err) => task.ioErrors.push(`stdout: ${err.message}`));
    child.stderr?.on('data', (chunk) => {
      task.stderrTail = tail(task.stderrTail + chunk.toString('utf8'), STDERR_KEEP);
    });
    child.stderr?.on('error', () => {});
    child.on('error', (err) => {
      void fail(task, bridgeError('codex/spawn-failed', `codex process error: ${err.message}`));
    });
    child.on('close', (code, signal) => {
      const rest = decoder.flush();
      if (rest) handleCodexEvent(task, rest);
      if (task.settled) return;
      if (code === 0) {
        if (!task.turnEnd) {
          task.turnEnd = {
            reason: 'process-exit',
            exitCode: 0,
            at: new Date().toISOString(),
          };
        }
        void finish(task, 'done');
        return;
      }
      void fail(
        task,
        bridgeError(
          'codex/process-exit',
          `codex exec exited with code ${code}${signal ? ` (signal ${signal})` : ''}`,
        ),
        { exitCode: code, signal: signal || null },
      );
    });

    // Prompt goes over stdin as UTF-8.
    try {
      child.stdin?.on('error', () => {});
      child.stdin?.end(Buffer.from(`${task.message}\n`, 'utf8'));
    } catch (err) {
      task.ioErrors.push(`stdin: ${err.message}`);
    }

    task.timer = setTimeout(() => {
      if (task.settled) return;
      task.timedOut = true;
      void fail(
        task,
        bridgeError(
          'codex/timeout',
          `codex exec resume did not finish within ${task.timeoutMs}ms`,
        ),
      );
      killTree(task);
    }, task.timeoutMs);
    return undefined;
  }

  async function startQueue(task) {
    const bin = task.codexBin || config.codexBin;
    if (!bin) {
      return fail(
        task,
        bridgeError(
          'codex/bin-not-found',
          'codex CLI not found: pass options.codexBin or put codex.exe on PATH',
        ),
      );
    }
    let child;
    try {
      child = config.spawn(bin, ['queue', '--thread', task.threadId, '--message', task.message], {
        cwd: task.cwd || config.cwd,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      return fail(task, bridgeError('codex/spawn-failed', `failed to spawn codex: ${err.message}`));
    }
    task.child = child;
    task.pid = child.pid || null;
    task.spawnedAt = new Date().toISOString();
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => {
      stdout = tail(stdout + chunk.toString('utf8'), 8_000);
    });
    child.stderr?.on('data', (chunk) => {
      stderr = tail(stderr + chunk.toString('utf8'), 8_000);
    });
    child.on('error', (err) => {
      void fail(task, bridgeError('codex/spawn-failed', `codex process error: ${err.message}`));
    });
    const timer = setTimeout(() => {
      if (task.settled) return;
      stderr = tail(`${stderr}\n[client] queue command timed out`, 8_000);
      void fail(task, bridgeError('codex/timeout', `codex queue did not finish within ${task.timeoutMs}ms`));
      killTree(task);
    }, task.timeoutMs);
    task.timer = timer;
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (task.settled) return;
      task.stderrTail = tail(stderr, STDERR_KEEP);
      const queued = /Queued message\s+\S+\s+for thread/i.test(stdout);
      if (code === 0 && queued) {
        task.note =
          'queued only: Codex consumes it when that thread is open in the Codex TUI/Desktop app; this channel does not track the turn';
        appendEvents(task, { type: 'client/queue', ok: true, stdout: tail(stdout, 2000) });
        return finish(task, 'queued');
      }
      appendEvents(task, {
        type: 'client/queue',
        ok: false,
        stdout: tail(stdout, 2000),
        stderr: tail(stderr, 2000),
      });
      return fail(
        task,
        bridgeError(
          'codex/queue-failed',
          code === 0
            ? 'codex queue did not confirm the queued message'
            : `codex queue exited with code ${code}${signal ? ` (signal ${signal})` : ''}`,
        ),
        { exitCode: code, signal: signal || null },
      );
    });
    return undefined;
  }

  async function prepareTask(task) {
    await fs.mkdir(task.taskDir, { recursive: true });
    await appendEvents(task, {
      type: 'client/send',
      taskId: task.taskId,
      threadId: task.threadId,
      delivery: task.delivery,
      at: task.startedAt,
      title: task.title ?? null,
      messageLength: task.message.length,
    });
    await persistMeta(task);
  }

  function snapshot(task) {
    return {
      taskId: task.taskId,
      threadId: task.threadId,
      delivery: task.delivery,
      state: task.state,
      reply: task.reply || '',
      turnEnd: task.turnEnd || null,
      usage: task.usage || null,
      error: task.error || null,
      note: task.note || null,
      startedAt: task.startedAt,
      updatedAt: task.updatedAt,
      cwd: task.cwd,
      taskDir: task.taskDir,
    };
  }

  async function readTaskFromDisk(taskId) {
    if (!safeTaskDirName(taskId)) return null;
    const taskDir = path.join(config.logDir, taskId);
    let meta;
    try {
      meta = JSON.parse(await fs.readFile(path.join(taskDir, 'meta.json'), 'utf8'));
    } catch {
      return null;
    }
    if (!meta || meta.taskId !== taskId) return null;
    let reply = typeof meta.reply === 'string' ? meta.reply : '';
    if (isTerminal(meta.state)) {
      try {
        reply = await fs.readFile(path.join(taskDir, 'reply.txt'), 'utf8');
      } catch {
        /* keep meta.reply */
      }
    }
    return {
      taskId: meta.taskId,
      threadId: meta.threadId,
      delivery: meta.delivery,
      state: meta.state,
      reply,
      turnEnd: meta.turnEnd || null,
      usage: meta.usage || null,
      error: meta.error || null,
      note: meta.note || null,
      startedAt: meta.startedAt,
      updatedAt: meta.updatedAt,
      cwd: meta.cwd,
      taskDir,
    };
  }

  function getTask(taskId) {
    if (typeof taskId !== 'string' || !taskId) {
      throw bridgeError('codex/bad-request', 'taskId is required');
    }
    return tasks.get(taskId) || null;
  }

  const client = {
    codexBin: config.codexBin,
    get available() {
      return Boolean(config.codexBin);
    },
    cwd: config.cwd,
    logDir: config.logDir,
    sessionsDir: config.sessionsDir,

    /**
     * List resumable Codex threads, newest first.
     * @param {{cwd?:string, limit?:number, all?:boolean}} [params]
     *  - cwd: exact (case-insensitive) cwd filter. Defaults to the client cwd.
     *  - all: true disables the cwd filter and lists every thread.
     *  - limit: default 10, clamped to 1..200.
     * @returns {Promise<Array<{threadId:string,cwd:string|null,title:string|null,updatedAt:string,rolloutPath:string}>>}
     */
    async listThreads(params = {}) {
      const { cwd, limit, all } = params && typeof params === 'object' ? params : {};
      let wanted = null;
      if (!all) {
        if (typeof cwd === 'string' && cwd) wanted = normalizePathForCompare(cwd);
        else if (config.cwd) wanted = normalizePathForCompare(config.cwd);
      }
      const max = Math.min(Math.max(Number.isFinite(limit) ? Math.trunc(limit) : 10, 1), 200);

      // title/updated_at index (may be absent on fresh installs)
      const titles = new Map();
      try {
        const raw = await fs.readFile(config.indexFile, 'utf8');
        for (const line of raw.split(/\r?\n/)) {
          if (!line.trim()) continue;
          try {
            const entry = JSON.parse(line);
            if (entry && typeof entry.id === 'string') {
              titles.set(entry.id.toLowerCase(), {
                title: typeof entry.thread_name === 'string' ? entry.thread_name : null,
                updatedAt: asIsoString(entry.updated_at),
              });
            }
          } catch {
            /* skip malformed index lines */
          }
        }
      } catch {
        /* index optional */
      }

      const files = await collectRolloutFiles(config.sessionsDir);
      const records = await mapLimit(files, LIST_CONCURRENCY, async (filePath) => {
        let mtimeMs = 0;
        try {
          mtimeMs = (await fs.stat(filePath)).mtimeMs;
        } catch {
          return null;
        }
        const first = await readFirstLine(filePath);
        if (!first) return null;
        let entry;
        try {
          entry = JSON.parse(first);
        } catch {
          return null;
        }
        if (!entry || entry.type !== 'session_meta' || !entry.payload) return null;
        const payload = entry.payload;
        const threadId = String(payload.id || payload.session_id || threadIdFromFilename(filePath) || '');
        if (!threadId) return null;
        if (payload.thread_source === 'subagent' || (payload.source && payload.source.subagent)) return null;
        const threadCwd =
          typeof payload.cwd === 'string'
            ? payload.cwd
            : Array.isArray(payload.runtime_workspace_roots) && typeof payload.runtime_workspace_roots[0] === 'string'
              ? payload.runtime_workspace_roots[0]
              : null;
        const indexEntry = titles.get(threadId.toLowerCase());
        const updatedAt = (indexEntry && indexEntry.updatedAt) || new Date(mtimeMs).toISOString();
        return {
          threadId,
          cwd: threadCwd,
          title: (indexEntry && indexEntry.title) || null,
          updatedAt,
          rolloutPath: filePath,
          createdAt: asIsoString(payload.timestamp) || asIsoString(entry.timestamp),
          _mtimeMs: mtimeMs,
        };
      });

      const deduped = new Map();
      for (const record of records) {
        if (!record) continue;
        if (wanted && normalizePathForCompare(record.cwd) !== wanted) continue;
        const key = record.threadId.toLowerCase();
        const existing = deduped.get(key);
        if (!existing || Date.parse(record.updatedAt) > Date.parse(existing.updatedAt)) {
          deduped.set(key, record);
        }
      }
      return [...deduped.values()]
        .sort((a, b) => {
          const delta = Date.parse(b.updatedAt || 0) - Date.parse(a.updatedAt || 0);
          if (delta !== 0 && Number.isFinite(delta)) return delta;
          return b._mtimeMs - a._mtimeMs;
        })
        .slice(0, max)
        .map((record) => ({
          threadId: record.threadId,
          cwd: record.cwd,
          title: record.title,
          updatedAt: record.updatedAt,
          rolloutPath: record.rolloutPath,
        }));
    },

    /**
     * Start a task without waiting for it to finish.
     * @param {{threadId:string, message:string, title?:string, cwd?:string,
     *          delivery?:'resume'|'queue', timeoutMs?:number}} params
     */
    async send(params = {}) {
      const p = params && typeof params === 'object' ? params : {};
      const threadId = typeof p.threadId === 'string' ? p.threadId.trim() : '';
      const message = typeof p.message === 'string' ? p.message : '';
      const delivery = p.delivery === 'queue' ? 'queue' : 'resume';
      if (!threadId) throw bridgeError('codex/bad-request', 'threadId is required');
      if (!message.trim()) throw bridgeError('codex/bad-request', 'message is required');
      if (p.delivery && p.delivery !== 'resume' && p.delivery !== 'queue') {
        throw bridgeError('codex/bad-request', `unsupported delivery: ${p.delivery}`);
      }

      const task = {
        delivery,
        threadId,
        message,
        title: typeof p.title === 'string' ? p.title : null,
        cwd: typeof p.cwd === 'string' && p.cwd ? path.resolve(p.cwd) : config.cwd,
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        state: 'queued',
        reply: '',
        usage: null,
        turnEnd: null,
        error: null,
        note: null,
        child: null,
        pid: null,
        timer: null,
        settled: false,
        parseErrors: 0,
        warnings: [],
        ioErrors: [],
        stderrTail: '',
        timeoutMs:
          Number.isFinite(p.timeoutMs) && p.timeoutMs > 0
            ? p.timeoutMs
            : delivery === 'queue'
              ? config.queueTimeoutMs
              : config.resumeTimeoutMs,
      };
      task.taskId = makeTaskId();
      task.codexBin = config.codexBin;
      task.taskDir = path.join(config.logDir, task.taskId);
      task.metaPath = path.join(task.taskDir, 'meta.json');
      task.eventsPath = path.join(task.taskDir, 'events.jsonl');
      task.replyPath = path.join(task.taskDir, 'reply.txt');
      task.emitter = new EventEmitter();
      task.finalized = new Promise((resolve) => {
        task.resolveFinal = resolve;
      });

      // Busy check + lock are synchronous: two concurrent resume sends for the
      // same thread cannot both proceed.
      if (delivery === 'resume') {
        const busyTaskId = threadLocks.get(threadId);
        if (busyTaskId && tasks.get(busyTaskId) && !tasks.get(busyTaskId).settled) {
          throw bridgeError(
            'codex/thread-busy',
            `thread ${threadId} already has a running resume task (${busyTaskId})`,
            { threadId, taskId: busyTaskId },
          );
        }
        threadLocks.set(threadId, task.taskId);
      }

      tasks.set(task.taskId, task);
      pruneTasks();

      try {
        await prepareTask(task);
      } catch (err) {
        releaseLock(task);
        task.settled = true;
        task.state = 'error';
        task.error = { code: 'codex/io-error', message: `failed to prepare task directory: ${err.message}` };
        task.resolveFinal?.();
        task.emitter.emit('settle');
        throw bridgeError('codex/io-error', task.error.message, { taskId: task.taskId });
      }

      // Queue mode waits for the queue CLI only, never for the recipient agent.
      queueMicrotask(() => {
        const run = delivery === 'queue' ? startQueue(task) : startResume(task);
        Promise.resolve(run).catch((err) => fail(task, err));
      });

      if (delivery === 'queue') {
        await task.finalized;
        if (task.state === 'error') throw bridgeError(task.error?.code ?? 'codex/queue-failed',task.error?.message ?? 'queue transport failed',{taskId:task.taskId});
      }

      return {
        taskId: task.taskId,
        threadId: task.threadId,
        state: task.state,
        delivery: task.delivery,
        startedAt: task.startedAt,
        taskDir: task.taskDir,
      };
    },

    /**
     * Block until the task reaches a terminal state or waitMs elapses.
     * Uses the task's settle event plus a 250ms safety poll (never a tight loop).
     * @param {{taskId:string, waitMs?:number}} params
     */
    async wait(params = {}) {
      const p = params && typeof params === 'object' ? params : {};
      const waitMs = clampWait(p.waitMs);
      const deadline = Date.now() + waitMs;
      const task = getTask(p.taskId);
      if (!task) {
        const fromDisk = await readTaskFromDisk(p.taskId);
        if (!fromDisk) throw bridgeError('codex/task-not-found', `unknown taskId: ${p.taskId}`);
        if (isTerminal(fromDisk.state)) return fromDisk;
        return waitOnDisk(p.taskId, fromDisk, deadline, waitMs);
      }

      if (isTerminal(task.state)) {
        if (task.finalized) await task.finalized;
        return snapshot(task);
      }

      await new Promise((resolve) => {
        let done = false;
        let interval = null;
        let timer = null;
        const cleanup = () => {
          if (interval) clearInterval(interval);
          if (timer) clearTimeout(timer);
          task.emitter.removeListener('settle', onSettle);
        };
        const settle = () => {
          if (done) return;
          done = true;
          cleanup();
          resolve();
        };
        const onSettle = () => settle();
        task.emitter.once('settle', onSettle);
        interval = setInterval(() => {
          if (done) return;
          if (isTerminal(task.state)) {
            if (task.finalized) task.finalized.then(settle, settle);
            else settle();
          }
        }, POLL_INTERVAL_MS);
        timer = setTimeout(settle, waitMs);
      });
      return snapshot(task);
    },

    /** Non-blocking snapshot, from memory or from the on-disk task record. */
    async status(params = {}) {
      const p = params && typeof params === 'object' ? params : {};
      const task = getTask(p.taskId);
      if (p.metadataOnly === true) {
        if (task) return legacyResultView(snapshot(task),false);
        if (!safeTaskDirName(p.taskId)) throw bridgeError('codex/bad-request','invalid taskId');
        try {
          const meta=JSON.parse(await fs.readFile(path.join(config.logDir,p.taskId,'status.json'),'utf8'));
          if(meta.taskId!==p.taskId)throw Error('task identity mismatch');
          return legacyResultView(meta,false);
        } catch(error) {
          if(error.code!=='ENOENT')throw error;
          try { await fs.access(path.join(config.logDir,p.taskId,'meta.json')); }
          catch { throw bridgeError('codex/task-not-found','unknown taskId'); }
          return {taskId:p.taskId,state:'unknown',reply:null,readPolicy:'push-only-until-closed',archiveAvailable:false,nextAction:'旧记录没有独立元数据；未读取旧正文文件。等待主动消息并完成实际验收。'};
        }
      }
      if (task) return snapshot(task);
      const fromDisk = await readTaskFromDisk(p.taskId);
      if (!fromDisk) throw bridgeError('codex/task-not-found', `unknown taskId: ${p.taskId}`);
      return fromDisk;
    },

    /** Kill a running task (child process tree) and mark it as error. */
    async cancel(params = {}) {
      const p = params && typeof params === 'object' ? params : {};
      const task = getTask(p.taskId);
      if (!task) {
        const fromDisk = await readTaskFromDisk(p.taskId);
        if (!fromDisk) throw bridgeError('codex/task-not-found', `unknown taskId: ${p.taskId}`);
        return fromDisk; // already finished before a restart
      }
      if (!task.settled) {
        task.cancelled = true;
        await fail(task, bridgeError('codex/cancelled', 'task cancelled by caller'));
        killTree(task);
      }
      return snapshot(task);
    },

    /** Read raw events for a task (debugging / UI). */
    async events(params = {}) {
      const p = params && typeof params === 'object' ? params : {};
      if (!safeTaskDirName(p.taskId)) throw bridgeError('codex/bad-request', 'invalid taskId');
      try {
        const raw = await fs.readFile(path.join(config.logDir, p.taskId, 'events.jsonl'), 'utf8');
        return raw
          .split(/\r?\n/)
          .filter(Boolean)
          .map((line) => {
            try {
              return JSON.parse(line);
            } catch {
              return { type: 'client/raw', line };
            }
          });
      } catch (err) {
        throw bridgeError('codex/task-not-found', `no events for taskId ${p.taskId}: ${err.message}`);
      }
    },
  };

  async function waitOnDisk(taskId, initial, deadline, waitMs) {
    let current = initial;
    const pollMs = Math.min(POLL_INTERVAL_MS, Math.max(waitMs, POLL_INTERVAL_MS));
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now();
      await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, Math.max(remaining, 0))));
      const next = await readTaskFromDisk(taskId);
      if (next) current = next;
      if (isTerminal(current.state)) return current;
    }
    return current;
  }

  function pruneTasks() {
    if (tasks.size <= MAX_TERMINAL_TASKS) return;
    for (const [id, task] of tasks) {
      if (tasks.size <= MAX_TERMINAL_TASKS) break;
      if (task.settled) tasks.delete(id);
    }
  }

  return client;
}

// Internal helpers exposed for the test suite only (not part of the public
// plugin API; index.js must rely on createCodexClient()).
export const __internals = {
  LineDecoder,
  parseCodexEvent,
  resolveCodexBin,
  readFirstLine,
  normalizePathForCompare,
  DEFAULT_RESUME_TIMEOUT_MS,
  MAX_WAIT_MS,
};
