/**
 * Durable state for the agent-bridge DSH plugin.
 *
 * Owns:
 *   - the bearer token (rotated on every host start)
 *   - endpoint.json (discovery file read by the Codex MCP server)
 *   - tasks.json (Codex→DSH task records; bounded, restart-recoverable)
 *   - audit.jsonl (headers only: no message bodies, no replies)
 *
 * Nothing here touches DSH session storage or Codex session storage.
 */
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, writeFile, appendFile, chmod } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const TASK_LIMIT = 200

export function createStore({ stateDir, logger = console }) {
  const tokenPath = join(stateDir, 'token')
  const endpointPath = join(stateDir, 'endpoint.json')
  const tasksPath = join(stateDir, 'tasks.json')
  const auditPath = join(stateDir, 'audit.jsonl')

  let token
  let saveTimer
  let pendingTasks

  const ensureDir = async () => {
    await mkdir(stateDir, { recursive: true })
  }

  const atomicWrite = async (file, text) => {
    await mkdir(dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
    await writeFile(tmp, text, 'utf8')
    await rename(tmp, file)
  }

  const loadToken = async () => {
    try {
      const existing = (await readFile(tokenPath, 'utf8')).trim()
      if (/^[0-9a-f]{32,128}$/i.test(existing)) return existing
    } catch {
      /* missing token: create one below */
    }
    const created = randomBytes(32).toString('hex')
    await ensureDir()
    await writeFile(tokenPath, `${created}\n`, 'utf8')
    try {
      await chmod(tokenPath, 0o600)
    } catch {
      /* Windows ACLs already keep the file in the user profile */
    }
    return created
  }

  const store = {
    dir: stateDir,
    tokenPath,
    endpointPath,
    tasksPath,
    auditPath,

    async init() {
      await ensureDir()
      token = await loadToken()
      return store
    },

    token() {
      if (token === undefined) throw new Error('agent-bridge store not initialised')
      return token
    },

    async writeEndpoint(info) {
      await atomicWrite(endpointPath, `${JSON.stringify(info, null, 2)}\n`)
    },

    async readTasks() {
      try {
        const raw = await readFile(tasksPath, 'utf8')
        const parsed = JSON.parse(raw)
        return Array.isArray(parsed?.tasks) ? parsed.tasks.slice(0, TASK_LIMIT) : []
      } catch {
        return []
      }
    },

    /** Debounced, atomic persistence. Failures are logged, never thrown at callers. */
    saveTasks(tasks) {
      pendingTasks = tasks.slice(0, TASK_LIMIT)
      if (saveTimer !== undefined) return
      saveTimer = setTimeout(() => {
        saveTimer = undefined
        const snapshot = pendingTasks
        pendingTasks = undefined
        if (snapshot === undefined) return
        atomicWrite(tasksPath, `${JSON.stringify({ version: 1, tasks: snapshot }, null, 2)}\n`).catch((error) => {
          logger.warn?.(`agent-bridge: could not persist tasks: ${String(error)}`)
        })
      }, 250)
      saveTimer.unref?.()
    },

    async audit(entry) {
      const line = JSON.stringify({ at: new Date().toISOString(), ...entry })
      try {
        await appendFile(auditPath, `${line}\n`, 'utf8')
      } catch {
        /* audit is best-effort */
      }
    },

    async close() {
      if (saveTimer !== undefined) {
        clearTimeout(saveTimer)
        saveTimer = undefined
        const snapshot = pendingTasks
        pendingTasks = undefined
        if (snapshot !== undefined) {
          try {
            await atomicWrite(tasksPath, `${JSON.stringify({ version: 1, tasks: snapshot }, null, 2)}\n`)
          } catch {
            /* best-effort flush */
          }
        }
      }
    },
  }

  return store
}
