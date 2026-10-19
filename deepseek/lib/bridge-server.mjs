/**
 * agent-bridge HTTP server (Codex → DSH direction).
 *
 * Mounted by index.js on DSH's loopback web server under the configured prefix.
 * It only ever receives messages from this machine and only ever talks to
 * `ctx.sessionController`; it never reads or writes session storage directly.
 */
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { asNumber, asString, clip, contentText, isoNow, normalizePath } from './util.mjs'
import { join } from 'node:path'
import { createLifecycle } from './lifecycle.mjs'

const STATUSES = new Set(['DONE', 'BLOCKED', 'QUESTION', 'INFO'])
const TERMINAL = new Set(['done', 'error', 'cancelled'])

const MAX_BODY_BYTES = 128 * 1024
const MAX_SUMMARY = 4000
const MAX_REPLY = 20000
const DEFAULT_TASK_TIMEOUT_MS = 10 * 60 * 1000
const FOLLOWER_IDLE_MS = 5 * 60 * 1000

class BridgeError extends Error {
  constructor(code, message, status = 400) {
    super(message)
    this.code = code
    this.status = status
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export function createBridgeServer({ ctx, store, config, codexRef, logger = console, version = '1.0.0' }) {
  const prefix = config.prefix
  const workspaceRoot = typeof config.workspaceRoot === 'string' ? config.workspaceRoot : process.cwd()
  const maxWaitMs = clampNumber(config.maxWaitMs, 1000, 120000, 30000)
  const autoNotify = false // Legacy Stop events must never create automatic reply chains.
  const taskTimeoutMs = clampNumber(config.taskTimeoutMs, 30000, 60 * 60 * 1000, DEFAULT_TASK_TIMEOUT_MS)

  /** taskId → task record (Codex→DSH direction only). */
  const tasks = new Map()
  /** sessionId → follower (one live tail per DSH session). */
  const followers = new Map()
  /** requestId → taskId, for idempotent retries. */
  const requestIds = new Map()
  let disposed = false
  let endpointWritten
  const lifecycle = createLifecycle({
    file: join(store.dir, 'lifecycle.json'),
    async validateAgent(args) {
      if (args.side !== 'deepseek') return
      const sessions = await listSessions()
      if (!sessions.some(item => canonicalId(publicSession(item).sessionId) === canonicalId(args.sessionId))) {
        throw new BridgeError('agent/session-not-found', 'sessionId 不在真实宿主会话名录；请调用 deepseek_status 核对实际 sessionId 后登记，不要猜测', 404)
      }
    },
    async deliver({ target, task, eventId, content, replyRequired }) {
      if (target.side === 'deepseek') {
        if (content.length > MAX_SUMMARY) throw Object.assign(new BridgeError('request/too-large', `任务正文含投递头长度 ${content.length} 字符，当前上限 ${MAX_SUMMARY} 字符；请缩短或提供文件引用；未发送`, 413), { definitive: true })
        const sent = await sendTask({ requestId: eventId, sessionId: target.sessionId, title: task.title, status: 'INFO', summary: content, mode: 'queue' })
        return { state: 'queued', transportTaskId: sent.taskId, side: 'deepseek', replyRequired }
      }
      if (!codexRef.client) throw Object.assign(new Error('Codex客户端不可用；未发送'), { definitive: true })
      const sent = await codexRef.client.send({ threadId: target.sessionId, message: content, title: task.title, delivery: 'queue' })
      const result = await codexRef.client.wait({ taskId: sent.taskId, waitMs: 10000 })
      if (result.error) throw Object.assign(new Error(result.error.message), { code: result.error.code })
      return { state: result.state, transportTaskId: sent.taskId, side: 'codex', replyRequired, note: result.note ?? '队列命令处理中；尚未证实接收或消费。' }
    },
    async lookupLegacy({ legacyTaskId, legacyDirection }) {
      if (legacyDirection === 'codex-to-deepseek') {
        const t = tasks.get(legacyTaskId)
        return t ? { title: t.title, content: t.summary, state: t.state, receipt: publicTask(t) } : undefined
      }
      if (!codexRef.client) return undefined
      try { const t = await codexRef.client.status({ taskId: legacyTaskId }); return { title: '旧Codex桥接任务', content: t.reply || `旧任务 ${legacyTaskId}，正文不由历史结果接口暴露。`, state: t.state, receipt: t } } catch { return undefined }
    },
    async readReceipt({ receipt }) {
      if (receipt.side === 'deepseek') { const t = tasks.get(receipt.transportTaskId); return t ? { ...receipt, ...publicTask(t) } : receipt }
      if (receipt.side === 'codex' && codexRef.client) return { ...receipt, ...await codexRef.client.status({ taskId: receipt.transportTaskId }) }
      return receipt
    },
  })

  const log = {
    info: (message) => logger.info?.(message),
    warn: (message) => logger.warn?.(message),
  }

  /* ── task records ─────────────────────────────────────────────────── */

  function createTask({ sessionId, cwd, title, status, summary, refs, baselineSeq, direction = 'codex->dsh' }) {
    const taskId = `tsk_${randomUUID().replace(/-/gu, '').slice(0, 10)}`
    const now = isoNow()
    const task = {
      taskId,
      direction,
      sessionId,
      cwd,
      title,
      status,
      summary,
      refs,
      state: 'queued',
      createdAt: now,
      updatedAt: now,
      baselineSeq,
      matchTurn: undefined,
      matched: false,
      matchedSeq: undefined,
      turnSeq: undefined,
      reply: null,
      turnEnd: null,
      error: null,
      waiters: new Set(),
      timer: undefined,
      marker: taskId,
    }
    task.timer = setTimeout(() => {
      if (TERMINAL.has(task.state)) return
      task.state = 'error'
      task.error = {
        code: 'dsh/turn-timeout',
        message: `DSH 会话 ${sessionId} 在 ${Math.round(taskTimeoutMs / 1000)}s 内没有结束对应 turn`,
      }
      task.updatedAt = isoNow()
      settleWaiters(task)
      persist()
    }, taskTimeoutMs)
    task.timer.unref?.()
    tasks.set(taskId, task)
    if (tasks.size > 200) {
      for (const [id, old] of tasks) {
        if (tasks.size <= 200) break
        if (TERMINAL.has(old.state)) tasks.delete(id)
      }
    }
    return task
  }

  function publicTask(task) {
    const replyText = task.reply?.text
    return {
      taskId: task.taskId,
      state: task.state,
      sessionId: task.sessionId,
      cwd: task.cwd,
      title: task.title,
      status: task.status,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      turnSeq: task.turnSeq ?? null,
      matched: task.matched === true,
      reply:
        typeof replyText === 'string'
          ? { text: clip(replyText, MAX_REPLY), at: task.reply.at, truncated: replyText.length > MAX_REPLY }
          : null,
      turnEnd: task.turnEnd ?? null,
      ...(task.error === null ? {} : { error: task.error }),
    }
  }

  function settleWaiters(task) {
    for (const resolve of task.waiters) resolve()
    task.waiters.clear()
  }

  function persist() {
    const records = [...tasks.values()].map((task) => ({
      taskId: task.taskId,
      direction: task.direction,
      sessionId: task.sessionId,
      cwd: task.cwd,
      title: task.title,
      status: task.status,
      summary: task.summary,
      refs: task.refs,
      state: task.state,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      baselineSeq: task.baselineSeq,
      matchTurn: task.matchTurn,
      matched: task.matched,
      matchedSeq: task.matchedSeq,
      turnSeq: task.turnSeq,
      reply: task.reply,
      turnEnd: task.turnEnd,
      error: task.error,
    }))
    store.saveTasks(records)
  }

  async function restore() {
    const stored = await store.readTasks()
    for (const record of stored) {
      if (record === null || typeof record !== 'object' || typeof record.taskId !== 'string') continue
      const state = TERMINAL.has(record.state) ? record.state : 'error'
      const task = {
        ...record,
        state,
        matched: record.matched === true,
        waiters: new Set(),
        timer: undefined,
        error:
          TERMINAL.has(record.state) && record.state === 'error'
            ? record.error
            : TERMINAL.has(record.state)
              ? null
              : { code: 'dsh/interrupted', message: 'DSH 宿主重启，任务状态未知' },
      }
      tasks.set(task.taskId, task)
    }
    if (tasks.size > 0) log.info(`agent-bridge: restored ${tasks.size} task record(s)`)
  }

  /* ── followers: one live tail per session ─────────────────────────── */

  function terminal(state) {
    return TERMINAL.has(state)
  }

  function ensureFollower(sessionId) {
    const existing = followers.get(sessionId)
    if (existing !== undefined) return existing
    const follower = {
      sessionId,
      controller: new AbortController(),
      cursor: -1,
      ready: false,
      resolveReady: undefined,
      tasks: new Map(),
      idleTimer: undefined,
      closed: false,
    }
    follower.readyPromise = new Promise((resolve) => {
      follower.resolveReady = resolve
    })
    followers.set(sessionId, follower)
    void pump(follower)
    return follower
  }

  async function pump(follower) {
    try {
      const stream = ctx.sessionController.follow(
        { address: { kind: 'session', sessionId: follower.sessionId } },
        follower.controller.signal,
      )
      let seen = 0
      for await (const frame of stream) {
        if (follower.controller.signal.aborted || disposed) break
        seen += 1
        if (process.env.DSH_AGENT_BRIDGE_DEBUG === '1') {
          const preview = frame?.type === 'event'
            ? ` seq=${frame.event?.seq} type=${frame.event?.type} textChars=${contentText(frame.event?.data?.content ?? frame.event?.data?.message?.content).length}`
            : ''
          log.info(`agent-bridge: [follow ${follower.sessionId}] frame#${seen} ${String(frame?.type ?? 'unknown')}${preview}`)
        }
        if (frame?.type === 'snapshot') {
          const cursor = Number(frame.cursor)
          if (Number.isFinite(cursor) && cursor > follower.cursor) follower.cursor = cursor
          if (!follower.ready) {
            follower.ready = true
            follower.resolveReady?.()
          }
          continue
        }
        if (frame?.type === 'event') applyEvent(follower, frame.event)
      }
      if (process.env.DSH_AGENT_BRIDGE_DEBUG === '1') {
        log.warn(`agent-bridge: [follow ${follower.sessionId}] stream ended after ${seen} frame(s)`)
      }
    } catch (error) {
      if (!follower.controller.signal.aborted) {
        log.warn(`agent-bridge: session ${follower.sessionId} follow failed: ${String(error?.message ?? error)}`)
      }
    } finally {
      if (!follower.ready) {
        follower.ready = true
        follower.resolveReady?.()
      }
    }
  }

  function applyEvent(follower, event) {
    const seq = Number(event?.seq)
    if (!Number.isFinite(seq)) return
    if (seq > follower.cursor) follower.cursor = seq
    const type = event?.type
    const data = event?.data
    for (const task of follower.tasks.values()) {
      if (terminal(task.state)) continue
      if (type === 'user/message') {
        const text = contentText(data?.content)
        if (text.includes(task.marker)) {
          task.matched = true
          task.matchedSeq = seq
          task.state = 'running'
          task.updatedAt = isoNow()
          const turn = asNumber(data?.turn)
          if (turn !== undefined) task.matchTurn = turn
          log.info(`agent-bridge: task ${task.taskId} injected into ${task.sessionId}`)
        }
        continue
      }
      if (task.matched !== true) continue
      if (seq <= (task.matchedSeq ?? task.baselineSeq ?? -1)) continue
      if (type === 'turn/start') {
        task.state = 'running'
        task.turnSeq = seq
        continue
      }
      if (type === 'assistant/message') {
        const text = contentText(data?.message?.content)
        if (text.length > 0) {
          task.reply = { text, at: isoNow() }
          task.turnSeq = seq
          task.updatedAt = isoNow()
        }
        continue
      }
      if (type === 'turn/end') {
        const turn = asNumber(data?.turn)
        if (task.matchTurn !== undefined && turn !== undefined && turn < task.matchTurn) continue
        const reason = typeof data?.reason === 'string' ? data.reason : data?.reason?.kind
        task.state = reason === 'completed' || reason === 'max-tokens' ? 'done' : 'error'
        if (task.state === 'error') {
          task.error = {
            code: `dsh/turn-${reason ?? 'unknown'}`,
            message: `DSH turn 结束状态：${reason ?? 'unknown'}`,
          }
        }
        task.turnEnd = { reason: reason ?? 'unknown', at: isoNow() }
        task.updatedAt = isoNow()
        if (task.timer !== undefined) {
          clearTimeout(task.timer)
          task.timer = undefined
        }
        settleWaiters(task)
        persist()
        void store.audit({
          direction: 'codex->dsh',
          taskId: task.taskId,
          sessionId: task.sessionId,
          state: task.state,
          replyChars: task.reply?.text?.length ?? 0,
        })
        log.info(`agent-bridge: task ${task.taskId} settled as ${task.state}`)
      }
    }
    scheduleIdleCleanup(follower)
  }

  function scheduleIdleCleanup(follower) {
    if (follower.idleTimer !== undefined) return
    follower.idleTimer = setTimeout(() => {
      follower.idleTimer = undefined
      const busy = [...follower.tasks.values()].some((task) => !terminal(task.state))
      if (!busy) dropFollower(follower.sessionId)
    }, FOLLOWER_IDLE_MS)
    follower.idleTimer.unref?.()
  }

  function dropFollower(sessionId) {
    const follower = followers.get(sessionId)
    if (follower === undefined) return
    followers.delete(sessionId)
    follower.closed = true
    if (follower.idleTimer !== undefined) clearTimeout(follower.idleTimer)
    follower.idleTimer = undefined
    try {
      follower.controller.abort()
    } catch {
      /* already aborted */
    }
    follower.resolveReady?.()
    for (const task of follower.tasks.values()) {
      if (task.timer !== undefined) clearTimeout(task.timer)
      task.timer = undefined
      settleWaiters(task)
    }
    follower.tasks.clear()
  }

  /* ── sessions ─────────────────────────────────────────────────────── */

  async function listSessions() {
    const result = await ctx.sessionController.list({})
    const items = Array.isArray(result) ? result : Array.isArray(result?.items) ? result.items : []
    return items.filter((item) => item !== null && typeof item === 'object')
  }

  /**
   * One probe row for every session id representation we might see. The REST
   * form (`session-<uuid>`) and the bare uuid are the same session; keeping both
   * aligned keeps an explicit caller objective from mismatching on shape alone.
   */
  function probeRow(item) {
    const row = publicSession(item)
    if (row.sessionId !== undefined) {
      row.id = row.sessionId
      row.key = canonicalId(row.sessionId)
    }
    return row
  }

  function canonicalId(id) {
    if (typeof id !== 'string') return undefined
    return /^session-/u.test(id) ? id.slice('session-'.length) : id
  }

  function publicSession(item) {
    const id = asString(item.sessionId) ?? asString(item.id) ?? asString(item.id?.sessionId)
    return {
      sessionId: id,
      id,
      title: asString(item.title) ?? asString(item.header?.title) ?? '',
      cwd: asString(item.cwd) ?? '',
      running: item.running === true,
      blank: item.blank === true,
      agentAvailable: item.agentAvailable !== false,
      updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : typeof item.updatedAt === 'number' ? new Date(item.updatedAt).toISOString() : undefined,
    }
  }

  async function pickSession(explicitId) {
    const items = await listSessions()
    const usable = items.filter((item) => item.agentAvailable !== false && item.blank !== true)
    if (explicitId !== undefined) {
      const wanted = canonicalId(explicitId)
      const hit = usable.find((item) => canonicalId(item.sessionId) === wanted)
      if (hit === undefined) throw new BridgeError('dsh/session-not-found', `DSH 会话不存在或不可接消息：${explicitId}`, 404)
      return hit
    }
    const workspace = normalizePath(workspaceRoot)
    const inWorkspace = usable.filter((item) => workspace !== undefined && normalizePath(item.cwd) === workspace)
    const pool = inWorkspace.length > 0 ? inWorkspace : usable
    if (pool.length === 0) throw new BridgeError('bridge/not-ready', '当前没有可用的 DSH 会话', 503)
    pool.sort((left, right) => {
      const runningDelta = Number(right.running === true) - Number(left.running === true)
      if (runningDelta !== 0) return runningDelta
      const rightAt = Date.parse(right.updatedAt ?? '') || 0
      const leftAt = Date.parse(left.updatedAt ?? '') || 0
      return rightAt - leftAt
    })
    return pool[0]
  }

  /* ── Codex → DSH ──────────────────────────────────────────────────── */

  function formatInjection({ taskId, status, title, summary, refs }) {
    const lines = [`📨 [Codex → DSH] ${status} ｜ ${title}`]
    if (summary.length > 0) lines.push(clip(summary, MAX_SUMMARY))
    if (refs.length > 0) lines.push(`refs: ${refs.join(' ; ')}`)
    lines.push(`↩ 直接在本会话回复即可；Codex 端会用 taskId=${taskId} 读回结果。`)
    return lines.join('\n')
  }

  async function sendTask(input, options = {}) {
    const requestId = asString(input?.requestId)
    if (requestId !== undefined && requestIds.has(requestId)) {
      const existing = tasks.get(requestIds.get(requestId))
      if (existing !== undefined) {
        return {
          taskId: existing.taskId,
          sessionId: existing.sessionId,
          accepted: true,
          replayed: true,
        }
      }
    }
    const title = clip(asString(input?.title) ?? '(无标题)', 200)
    const rawStatus = asString(input?.status)?.toUpperCase()
    const status = STATUSES.has(rawStatus) ? rawStatus : 'INFO'
    const summary = asString(input?.summary) ?? ''
    if (summary.length > MAX_SUMMARY) throw new BridgeError('request/too-large', `任务正文长度 ${summary.length} 字符，当前上限 ${MAX_SUMMARY} 字符；请缩短或提供文件引用；未发送`, 413)
    const refs = Array.isArray(input?.refs) ? input.refs.filter((item) => typeof item === 'string').slice(0, 10) : []
    const mode = input?.mode === 'steer' ? 'steer' : 'queue'
    const session = await pickSession(asString(input?.sessionId))

    const follower = ensureFollower(session.sessionId)
    await follower.readyPromise
    let baselineSeq = follower.cursor
    const task = createTask({
      sessionId: session.sessionId,
      cwd: asString(session.cwd),
      title,
      status,
      summary,
      refs,
      baselineSeq,
      direction: options.direction ?? 'codex->dsh',
    })
    follower.tasks.set(task.taskId, task)
    const text = formatInjection({ taskId: task.taskId, status, title, summary, refs })
    try {
      await injectPrompt(session.sessionId, task.taskId, mode, text, options.signal)
    } catch (error) {      task.state = 'error'
      task.error = { code: 'dsh/prompt-failed', message: String(error?.message ?? error) }
      task.updatedAt = isoNow()
      if (task.timer !== undefined) clearTimeout(task.timer)
      task.timer = undefined
      settleWaiters(task)
      persist()
      throw new BridgeError('dsh/prompt-failed', task.error.message, 503)
    }
    if (requestId !== undefined) requestIds.set(requestId, task.taskId)
    persist()
    void store.audit({
      direction: 'codex->dsh',
      taskId: task.taskId,
      sessionId: session.sessionId,
      status,
      summaryChars: summary.length,
    })
    return { taskId: task.taskId, sessionId: session.sessionId, accepted: true, replayed: false }
  }

  /**
   * Inject one task message into a DSH session.
   *
   * `sessionController.prompt` dereferences its abort signal immediately
   * (`signal.throwIfAborted()`), so an undefined signal — which is what an
   * ordinary bridge call supplies — fails before the message is ever queued
   * with `Cannot read properties of undefined (reading 'throwIfAborted')`.
   * Always hand it a real AbortSignal, and only abort when the caller actually
   * asked for cancellation.
   */
  async function injectPrompt(sessionId, taskId, mode, text, externalSignal) {
    const controller = new AbortController()
    const forwardAbort = () => controller.abort(externalSignal?.reason)
    if (externalSignal?.aborted === true) forwardAbort()
    else externalSignal?.addEventListener?.('abort', forwardAbort, { once: true })
    try {
      const accepted = await ctx.sessionController.prompt(
        {
          requestId: `agent-bridge:${taskId}`,
          sessionId,
          mode,
          content: [{ type: 'text', text }],
        },
        controller.signal,
      )
      if (accepted?.accepted !== true) throw new Error('sessionController.prompt did not accept the message')
      log.info(`agent-bridge: injected task ${taskId} into ${sessionId} (mode=${mode})`)
      return accepted
    } finally {
      externalSignal?.removeEventListener?.('abort', forwardAbort)
    }
  }

  function requireTask(taskId) {
    const task = tasks.get(taskId)
    if (task === undefined) throw new BridgeError('not-found', `任务不存在：${taskId}`, 404)
    return task
  }

  /**
   * Diagnostic tail: observes one session's follow stream for a short window
   * without injecting anything. Read-only, loopback + token guarded.
   */
  async function debugFollow(params) {
    const sessionId = asString(params.get('sessionId'))
    if (sessionId === undefined) throw new BridgeError('request/bad-request', '缺少 sessionId', 400)
    const ms = clampNumber(params.get('ms'), 200, 15000, 3000)
    const frames = []
    const controller = new AbortController()
    const stream = ctx.sessionController.follow({ address: { kind: 'session', sessionId } }, controller.signal)
    const deadline = setTimeout(() => controller.abort(), ms)
    deadline.unref?.()
    try {
      for await (const frame of stream) {
        if (frame?.type === 'snapshot') {
          frames.push({ type: 'snapshot', cursor: frame.cursor })
        } else if (frame?.type === 'event') {
          frames.push({
            type: 'event',
            seq: frame.event?.seq,
            kind: frame.event?.type,
            text: clip(contentText(frame.event?.data?.content ?? frame.event?.data?.message?.content), 160),
          })
        } else {
          frames.push({ type: String(frame?.type ?? 'unknown') })
        }
        if (frames.length >= 40) break
      }
    } catch (error) {
      frames.push({ type: 'error', message: String(error?.message ?? error) })
    } finally {
      clearTimeout(deadline)
      controller.abort()
    }
    return { sessionId, windowMs: ms, frames }
  }

  async function waitTask(taskId, waitMs) {
    const task = requireTask(taskId)
    if (terminal(task.state)) return publicTask(task)
    const budget = clampNumber(waitMs, 0, maxWaitMs, 0)
    if (budget <= 0) return publicTask(task)
    await new Promise((resolve) => {
      let done = false
      const finish = () => {
        if (done) return
        done = true
        task.waiters.delete(finish)
        clearTimeout(timer)
        resolve()
      }
      const timer = setTimeout(finish, budget)
      timer.unref?.()
      task.waiters.add(finish)
      // A settle that raced with the check above must not leave us waiting.
      if (terminal(task.state)) finish()
    })
    return publicTask(task)
  }

  /* ── HTTP plumbing ────────────────────────────────────────────────── */

  function updateEndpoint(host) {
    if (typeof host !== 'string' || !/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/u.test(host)) return
    const baseUrl = `http://${host}${prefix}`
    if (endpointWritten === baseUrl) return
    endpointWritten = baseUrl
    void store
      .writeEndpoint({
        protocol: 1,
        baseUrl,
        tokenPath: store.tokenPath,
        workspaceRoot,
        pluginVersion: version,
        updatedAt: isoNow(),
      })
      .catch((error) => log.warn(`agent-bridge: could not write endpoint.json: ${String(error)}`))
  }

  function authorized(req) {
    const header = req.headers?.authorization
    if (typeof header !== 'string' || !header.toLowerCase().startsWith('bearer ')) {
      throw new BridgeError('auth/missing-token', '缺少 Bearer token', 401)
    }
    const provided = Buffer.from(header.slice(7).trim(), 'utf8')
    const expected = Buffer.from(store.token(), 'utf8')
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
      throw new BridgeError('auth/invalid-token', 'token 不匹配', 403)
    }
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = []
      let size = 0
      req.on('data', (chunk) => {
        size += chunk.length
        if (size > MAX_BODY_BYTES) {
          reject(new BridgeError('request/too-large', `请求体超过 ${MAX_BODY_BYTES} 字节`, 413))
          req.destroy()
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8').trim()
        if (raw.length === 0) {
          resolve({})
          return
        }
        try {
          const parsed = JSON.parse(raw)
          resolve(parsed !== null && typeof parsed === 'object' ? parsed : {})
        } catch {
          reject(new BridgeError('request/bad-request', '请求体不是合法 JSON', 400))
        }
      })
      req.on('error', (error) => reject(error))
    })
  }

  function sendJson(res, status, payload) {
    if (res.writableEnded) return
    const body = JSON.stringify(payload)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
      'cache-control': 'no-store',
    })
    res.end(body)
  }

  function sendValue(res, value) {
    sendJson(res, 200, { ok: true, value })
  }

  function sendFailure(res, error) {
    const status = Number.isInteger(error?.status) ? error.status : 500
    const code = typeof error?.code === 'string' ? error.code : 'bridge/internal'
    const message = String(error?.message ?? error ?? 'unknown error')
    sendJson(res, status, { ok: false, error: { code, message } })
  }

  const codexStatus = () => {
    if (codexRef.client === null || codexRef.client === undefined) {
      return { available: false, error: codexRef.error ?? 'codex-client-unavailable' }
    }
    return { available: true, bin: codexRef.client.binPath ?? codexRef.binPath ?? null }
  }

  async function healthValue() {
    const sessions = await listSessions().catch(() => [])
    const open = [...tasks.values()].filter((task) => !terminal(task.state)).length
    return {
      version,
      protocol: 1,
      workspaceRoot,
      dsh: {
        sessions: sessions.length,
        running: sessions.filter((item) => item.running === true).length,
      },
      codex: codexStatus(),
      tasks: { open, total: tasks.size },
    }
  }

  async function handle(req, res) {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const method = req.method ?? 'GET'
    const route = url.pathname.slice(prefix.length) || '/'
    updateEndpoint(req.headers?.host)
    try {
      if (method === 'GET' && route === '/ping') {
        sendValue(res, { protocol: 1, pid: process.pid })
        return
      }
      authorized(req)
      if (method === 'POST' && (route === '/v2/agent' || route === '/v2/task')) {
        sendValue(res, await lifecycle.command(route.endsWith('/agent') ? 'agent' : 'task', await readBody(req)))
        return
      }
      if (method === 'GET' && route === '/health') {
        sendValue(res, await healthValue())
        return
      }
      if (method === 'GET' && (route === '/sessions' || route === '/sessions/')) {
        const limit = clampNumber(url.searchParams.get('limit'), 1, 50, 10)
        const items = await listSessions()
        sendValue(res, { sessions: items.slice(0, limit).map(publicSession) })
        return
      }
      if (method === 'GET' && (route === '/debug/follow' || route === '/debug/follow/')) {
        sendValue(res, await debugFollow(url.searchParams))
        return
      }
      if (method === 'GET' && (route === '/tasks' || route === '/tasks/')) {        const limit = clampNumber(url.searchParams.get('limit'), 1, 100, 20)
        const items = [...tasks.values()]
          .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
          .slice(0, limit)
          .map(publicTask)
        sendValue(res, { tasks: items })
        return
      }
      if (method === 'POST' && route === '/tasks/send') {
        const body = await readBody(req)
        sendValue(res, await sendTask(body))
        return
      }
      if (method === 'POST' && route === '/events') {
        const body = await readBody(req)
        if (!autoNotify) {
          sendValue(res, { delivered: false, reason: 'disabled' })
          return
        }
        const threadId = asString(body?.threadId) ?? 'unknown-thread'
        const status = asString(body?.status)?.toUpperCase()
        const result = await sendTask(
          {
            requestId: `hook:${threadId}:${asString(body?.turnId) ?? Date.now()}`,
            title: asString(body?.title) ?? `Codex 会话 ${threadId.slice(0, 8)} 一轮结束`,
            status: STATUSES.has(status) ? status : 'INFO',
            summary: asString(body?.summary) ?? 'Codex Stop hook 上报（未携带摘要）。',
            refs: [`codex-thread:${threadId}`],
          },
          { direction: 'codex-hook' },
        )
        sendValue(res, { delivered: true, taskId: result.taskId, sessionId: result.sessionId })
        return
      }
      const single = /^\/tasks\/([^/]+)$/u.exec(route)
      if (single !== null && method === 'GET') {
        sendValue(res, publicTask(requireTask(decodeURIComponent(single[1]))))
        return
      }
      const wait = /^\/tasks\/([^/]+)\/wait$/u.exec(route)
      if (wait !== null && method === 'POST') {
        const body = await readBody(req)
        sendValue(res, await waitTask(decodeURIComponent(wait[1]), asNumber(body?.waitMs)))
        return
      }
      throw new BridgeError('request/unsupported', `${method} ${prefix}${route} 不是 agent-bridge 端点`, 404)
    } catch (error) {
      if (res.headersSent !== true) sendFailure(res, error)
    }
  }

  async function init() {
    await store.init()
    await restore()
    await lifecycle.init()
    log.info(`agent-bridge: state at ${store.dir}`)
  }

  function dispose() {
    disposed = true
    for (const sessionId of [...followers.keys()]) dropFollower(sessionId)
    for (const task of tasks.values()) {
      if (task.timer !== undefined) clearTimeout(task.timer)
      task.timer = undefined
      task.waiters.clear()
    }
  }

  return {
    prefix,
    init,
    handle,
    dispose,
    sendTask,
    lifecycle,
    publicSession,
    listSessions,
    healthValue,
    codexStatus,
    tasksSummary: () => ({
      open: [...tasks.values()].filter((task) => !terminal(task.state)).length,
      total: tasks.size,
    }),
    workspaceRoot,
    version,
  }
}

function clampNumber(value, min, max, fallback) {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(n)))
}

/**
 * Wait for a terminal state with a deadline helper used by tools and tests.
 * Exported for reuse; not part of the HTTP surface.
 */
export async function waitUntil(check, timeoutMs, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await check()
    if (value !== undefined && value !== null && value !== false) return value
    if (Date.now() >= deadline) return undefined
    await sleep(intervalMs)
  }
}
