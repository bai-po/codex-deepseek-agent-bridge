import {legacyResultView} from './read-policy.mjs'
/**
 * DSH tools that let a DSH agent push work to an existing Codex thread and
 * inspect transport metadata. Replies must be actively pushed to this chat.
 * Transport: local `codex` CLI subprocess (exec resume / queue),
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
    if (typeof value.error?.code === 'string' && value.error.code.length > 0) lines.push(`error: ${value.error.code}`)
    if (value.note !== undefined && value.note !== null) lines.push(`note: ${value.note}`)
    return lines.join('\n')
  }

  /* ── codex_task ───────────────────────────────────────────────────── */

  const codexTaskDefinition = {
    name: 'codex_task',
    description:
      'Send a task or message from this DeepSeek Harness session to an existing Codex thread on this machine. This tool returns transport status only; it does not wait for or read a reply. Any reply must be actively pushed into this chat. Never pull an open peer report. Use it to delegate work to the Codex agent (implementation, code review, file edits in its own thread) and to keep long-running work off this conversation. Delivery defaults to "queue" for messages to a Desktop/TUI-owned chat; the current turn must finish before the queued message can run. Always pass the exact `thread` supplied by the recipient or selected from codex_threads; never guess the latest thread. Explicit "resume" is only for an idle thread not owned by another client and starts a separate CLI run. Queue acceptance does not prove consumption or a reply.',
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
        description: 'Deprecated compatibility field; sending never waits for or reads the peer reply.',
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
          reply: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          replyPath: { type: 'string' },
          turnEnd: { oneOf: [{ type: 'object', additionalProperties: true }, { type: 'null' }] },
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
      return {...legacyResultView({...sent,threadId},false),note:'消息已提交传输；请等待对方主动发送消息。提交不证明队列接受、消费或验收。'}

    },
  }

  /* ── codex_result ─────────────────────────────────────────────────── */

  const codexResultDefinition = {
    name: 'codex_result',
    description:
      'Read metadata only while open; never wait for or pull peer body. Only verified bilateral closure permits this exact transport archive. done is not closure.',
    parameters: {
      taskId: { type: 'string', required: true, description: 'Task id returned by codex_task.' },
      waitMs: {
        type: 'number',
        description: 'Deprecated compatibility field; ignored. codex_result always returns the current status immediately.',
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
          reply: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          replyPath: { type: 'string' },
          turnEnd: { oneOf: [{ type: 'object', additionalProperties: true }, { type: 'null' }] },
          usage: { type: 'object', additionalProperties: true },
          error: { type: 'object', additionalProperties: true },
        },
      },
      render: (_args, value) => text(describeResult(value)),
    },
    timeoutMs: 30000,
    async execute(args) {
      const client = requireClient()
      const taskId = typeof args?.taskId === 'string' ? args.taskId.trim() : ''
      if (taskId.length === 0) throw FAIL('request/bad-request', 'taskId 不能为空')
      const archived = bridge.lifecycle.isTransportClosed(taskId)
      const result = await client.status({taskId,metadataOnly:!archived})
      return legacyResultView({...result,taskId},archived)

    },
  }

  /* ── codex_threads ────────────────────────────────────────────────── */

  const codexThreadsDefinition = {
    name: 'codex_threads',
    description:
      'List Codex threads on this machine for this workspace, newest first, so a thread id can be passed to codex_task. This is the only remaining rollout read: it reads only the first-line/header metadata for thread discovery, never task or conversation bodies.',
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



