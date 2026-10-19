/**
 * DSH tools that let a DSH agent push work to an existing Codex thread and read
 * the reply back. Transport: local `codex` CLI subprocess (exec resume / queue),
 * implemented by lib/codex-client.mjs.
 */
import { parameterSchemaSpecToJsonSchema } from '@deepseek-ai/dsh-tools'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { clip } from './util.mjs'

const MAX_TOOL_REPLY = 6000
const TASKS_DIR = join(homedir(), '.dsh', 'agent-bridge', 'codex-tasks')

const FAIL = (code, message) => {
  const error = new Error(message)
  error.code = code
  return error
}

const text = (value) => [{ type: 'text', text: value }]

export function registerTools(ctx, deps) {
  const { bridge, codexRef, store } = deps
  const disposers = []

  const requireClient = () => {
    if (codexRef.client === null || codexRef.client === undefined) {
      throw FAIL('codex/unavailable', `Codex 客户端不可用：${codexRef.error ?? 'unknown'}`)
    }
    return codexRef.client
  }

  const replyPathOf = (taskId) => join(store.dir, 'codex-tasks', taskId, 'reply.txt')

  const describeResult = (value) => {
    const lines = [`taskId: ${value.taskId}`, `state: ${value.state}`, `thread: ${value.threadId}`]
    if (value.reply !== undefined && value.reply !== null && value.reply.length > 0) {
      lines.push('', '--- Codex 回复 ---', clip(value.reply, MAX_TOOL_REPLY))
      lines.push('', `完整回复文件: ${value.replyPath}`)
    }
    if (value.turnEnd !== undefined && value.turnEnd !== null) {
      lines.push(`turn: ${JSON.stringify(value.turnEnd)}`)
    }
    if (value.error !== undefined && value.error !== null) lines.push(`error: ${value.error.code} ${value.error.message}`)
    if (value.note !== undefined && value.note !== null) lines.push(`note: ${value.note}`)
    return lines.join('\n')
  }

  /* ── codex_task ───────────────────────────────────────────────────── */

  const codexTaskDefinition = {
    name: 'codex_task',
    description:
      'Send a task or message from this DeepSeek Harness session to an existing Codex thread on this machine, then read its reply. Use it to delegate work to the Codex agent (implementation, code review, file edits in its own thread) and to keep long-running work off this conversation. Delivery defaults to "queue" for messages to a Desktop/TUI-owned chat; the current turn must finish before the queued message can run. Always pass the exact `thread` supplied by the recipient or selected from codex_threads; never guess the latest thread. Explicit "resume" is only for an idle thread not owned by another client and starts a separate CLI run. Queue acceptance does not prove consumption or a reply.',
    parameters: {
      message: {
        type: 'string',
        required: true,
        description: 'Task text for the Codex agent. Be self-contained: goal, files, constraints, and how to report back.',
      },
      thread: {
        type: 'string',
        required: true,
        description: 'Exact recipient Codex thread UUID. Required to prevent messages reaching an unrelated latest chat.',
      },
      delivery: {
        type: 'string',
        enum: ['resume', 'queue'],
        description: 'queue (default) appends a message to the specified existing chat without competing for its writer; resume explicitly starts a CLI run on an unowned thread.',
      },
      title: {
        type: 'string',
        description: 'Short label for this delegation, shown in task listings and logs.',
      },
      waitMs: {
        type: 'number',
        description: 'Wait up to this many milliseconds for the reply before returning (max 120000). Omit to return as soon as the task is dispatched.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        required: ['taskId', 'threadId', 'state'],
        properties: {
          taskId: { type: 'string' },
          threadId: { type: 'string' },
          state: { type: 'string' },
          reply: { type: 'string' },
          replyPath: { type: 'string' },
          turnEnd: { type: 'object', additionalProperties: true },
          error: { type: 'object', additionalProperties: true },
          note: { type: 'string' },
        },
      },
      render: (_args, value) => text(describeResult(value)),
    },
    timeoutMs: 150000,
    async execute(args) {
      const client = requireClient()
      const message = typeof args?.message === 'string' ? args.message.trim() : ''
      if (message.length === 0) throw FAIL('request/bad-request', 'message 不能为空')
      const delivery = args?.delivery === 'resume' ? 'resume' : 'queue'
      let threadId = typeof args?.thread === 'string' ? args.thread.trim() : ''
      if (threadId.length === 0) throw FAIL('request/bad-request', 'thread 必须指定准确的接收聊天；不会自动选择最新聊天')
      const sent = await client.send({
        threadId,
        message,
        title: typeof args?.title === 'string' ? args.title : undefined,
        delivery,
      })
      const waitMs = typeof args?.waitMs === 'number' ? Math.min(Math.max(0, args.waitMs), 120000) : 0
      if (delivery === 'queue') {
        const queued = await client.wait({ taskId: sent.taskId, waitMs: 10000 })
        if (queued.error) throw FAIL(queued.error.code ?? 'codex/queue-failed', queued.error.message)
        return {
          taskId: sent.taskId,
          threadId,
          state: queued.state,
          note: queued.note ?? '队列命令仍在处理；请用 codex_result 检查是否被接受。排队不代表对方已收到或回复。',
        }
      }
      if (waitMs <= 0) return { taskId: sent.taskId, threadId, state: sent.state }
      const result = await client.wait({ taskId: sent.taskId, waitMs })
      return {
        taskId: sent.taskId,
        threadId: result.threadId ?? threadId,
        state: result.state,
        ...(typeof result.reply === 'string' && result.reply.length > 0
          ? { reply: clip(result.reply, MAX_TOOL_REPLY), replyPath: replyPathOf(sent.taskId) }
          : {}),
        ...(result.turnEnd === undefined || result.turnEnd === null ? {} : { turnEnd: result.turnEnd }),
        ...(result.error === undefined || result.error === null ? {} : { error: result.error }),
      }
    },
  }

  /* ── codex_result ─────────────────────────────────────────────────── */

  const codexResultDefinition = {
    name: 'codex_result',
    description:
      'Read or wait for the result of a Codex task started by codex_task. Returns the current state immediately when the task already finished; otherwise waits up to waitMs (default 60000, max 120000) for the Codex turn to end. State is queued|running|done|error.',
    parameters: {
      taskId: { type: 'string', required: true, description: 'Task id returned by codex_task.' },
      waitMs: {
        type: 'number',
        description: 'Maximum wait in milliseconds (default 60000, max 120000). Use 0 to only read the current state.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        required: ['taskId', 'state'],
        properties: {
          taskId: { type: 'string' },
          threadId: { type: 'string' },
          state: { type: 'string' },
          reply: { type: 'string' },
          replyPath: { type: 'string' },
          turnEnd: { type: 'object', additionalProperties: true },
          usage: { type: 'object', additionalProperties: true },
          error: { type: 'object', additionalProperties: true },
        },
      },
      render: (_args, value) => text(describeResult(value)),
    },
    timeoutMs: 130000,
    async execute(args) {
      const client = requireClient()
      const taskId = typeof args?.taskId === 'string' ? args.taskId.trim() : ''
      if (taskId.length === 0) throw FAIL('request/bad-request', 'taskId 不能为空')
      const waitMs = typeof args?.waitMs === 'number' ? Math.min(Math.max(0, args.waitMs), 120000) : 60000
      const result = await client.wait({ taskId, waitMs })
      return {
        taskId,
        ...(result.threadId === undefined ? {} : { threadId: result.threadId }),
        state: result.state,
        ...(typeof result.reply === 'string' && result.reply.length > 0
          ? { reply: clip(result.reply, MAX_TOOL_REPLY), replyPath: replyPathOf(taskId) }
          : {}),
        ...(result.turnEnd === undefined || result.turnEnd === null ? {} : { turnEnd: result.turnEnd }),
        ...(result.usage === undefined || result.usage === null ? {} : { usage: result.usage }),
        ...(result.error === undefined || result.error === null ? {} : { error: result.error }),
      }
    },
  }

  /* ── codex_threads ────────────────────────────────────────────────── */

  const codexThreadsDefinition = {
    name: 'codex_threads',
    description:
      'List Codex threads on this machine for this workspace, newest first, so a thread id can be passed to codex_task. Only reads each rollout file header; it never opens the conversation of a thread you did not ask for beyond its metadata.',
    parameters: {
      cwd: { type: 'string', description: 'Workspace directory to filter threads by (defaults to this bridge workspace).' },
      limit: { type: 'number', description: 'Maximum threads to return (1-20, default 10).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        required: ['threads'],
        properties: {
          threads: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: true,
              required: ['threadId'],
              properties: {
                threadId: { type: 'string' },
                title: { type: 'string' },
                cwd: { type: 'string' },
                updatedAt: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        if (value.threads.length === 0) return text('没有找到 Codex 线程。')
        const rows = value.threads.map(
          (thread) => `${thread.threadId}  ${thread.updatedAt ?? '-'}  ${thread.title ?? '(untitled)'}`,
        )
        return text(rows.join('\n'))
      },
    },
    timeoutMs: 20000,
    async execute(args) {
      const client = requireClient()
      const limit = typeof args?.limit === 'number' ? Math.min(Math.max(1, Math.trunc(args.limit)), 20) : 10
      const cwd = typeof args?.cwd === 'string' && args.cwd.length > 0 ? args.cwd : deps.workspaceRoot
      const threads = await client.listThreads({ cwd, limit })
      return {
        threads: threads.slice(0, limit).map((thread) => ({
          threadId: thread.threadId,
          ...(thread.title === undefined ? {} : { title: thread.title }),
          ...(thread.cwd === undefined ? {} : { cwd: thread.cwd }),
          ...(thread.updatedAt === undefined ? {} : { updatedAt: thread.updatedAt }),
        })),
      }
    },
  }

  /* ── bridge_status ────────────────────────────────────────────────── */

  const bridgeStatusDefinition = {
    name: 'bridge_status',
    description:
      'Report the state of the Codex ⇄ DeepSeek Harness bridge: whether the loopback endpoint is published, whether the codex CLI is available, the workspace, and how many tasks are open. Use it to diagnose "Codex 没收到" / "DSH 没收到" before retrying.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        required: ['ok', 'codex', 'tasks'],
        properties: {
          ok: { type: 'boolean' },
          baseUrl: { type: 'string' },
          protocol: { type: 'number' },
          workspaceRoot: { type: 'string' },
          codex: { type: 'object', additionalProperties: true },
          tasks: { type: 'object', additionalProperties: true },
          routeError: { type: 'string' },
        },
      },
      render: (_args, value) =>
        text(
          [
            `endpoint: ${value.baseUrl ?? '(未写入)'}`,
            `route: ${value.routeError ?? 'ok'}`,
            `workspace: ${value.workspaceRoot}`,
            `codex: ${JSON.stringify(value.codex)}`,
            `tasks: ${JSON.stringify(value.tasks)}`,
          ].join('\n'),
        ),
    },
    timeoutMs: 10000,
    async execute() {
      let endpoint
      try {
        endpoint = JSON.parse(await readFile(store.endpointPath, 'utf8'))
      } catch {
        endpoint = undefined
      }
      return {
        ok: true,
        ...(endpoint?.baseUrl === undefined ? {} : { baseUrl: endpoint.baseUrl }),
        ...(endpoint?.protocol === undefined ? {} : { protocol: endpoint.protocol }),
        workspaceRoot: deps.workspaceRoot,
        codex: bridge.codexStatus(),
        tasks: bridge.tasksSummary(),
        ...(typeof bridge.routeError === 'string' && bridge.routeError.length > 0 ? { routeError: bridge.routeError } : {}),
      }
    },
  }

  for (const definition of [codexTaskDefinition, codexResultDefinition, codexThreadsDefinition, bridgeStatusDefinition]) {
    disposers.push(ctx.tools.register({ ...definition, parameters: parameterSchemaSpecToJsonSchema(definition.parameters) }))
  }

  return disposers
}



