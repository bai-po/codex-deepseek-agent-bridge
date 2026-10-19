/**
 * Agent Bridge — a DeepSeek Harness bundle plugin.
 *
 * Two directions, one shared protocol (see ../../docs/protocol.md):
 *
 *   Codex → DSH  A loopback HTTP server mounted on DSH's own web server. Codex's
 *                MCP plugin posts short task messages; they are injected into a
 *                DSH session as ordinary user messages and the reply is tracked.
 *
 *   DSH → Codex  DSH tools (codex_task / codex_result) that run the local `codex`
 *                CLI against an existing Codex thread and return its answer.
 *
 * Everything is loopback-only and token-authenticated; no session storage is
 * read or written and nothing polls in the background beyond one live session
 * tail per session that currently has an open task.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { createStore } from './lib/store.mjs'
import { createBridgeServer } from './lib/bridge-server.mjs'
import { registerTools } from './lib/tools.mjs'
import { registerLifecycleTools } from './lib/lifecycle-tools.mjs'
import { isoNow, normalizePrefix } from './lib/util.mjs'

export const name = 'agent-bridge'
export const inject = ['webServer', 'sessionController', 'tools']

const VERSION = '1.0.3-local.1'

function resolveOrigin(ctx) {
  try {
    const origin = ctx.webServer?.getOrigin?.()
    if (typeof origin === 'string' && /^https?:\/\//u.test(origin)) return origin.replace(/\/+$/u, '')
    if (origin !== null && typeof origin === 'object') {
      const value = origin.origin ?? origin.url ?? origin.baseUrl
      if (typeof value === 'string' && /^https?:\/\//u.test(value)) return value.replace(/\/+$/u, '')
    }
  } catch {
    /* origin is best-effort */
  }
  return undefined
}

async function loadCodexClient(config, ctx, codexRef, logger) {
  try {
    const module = await import('./lib/codex-client.mjs')
    const factory = module.createCodexClient ?? module.default
    if (typeof factory !== 'function') throw new Error('codex-client.mjs has no createCodexClient export')
    const client = factory({
      codexBin: typeof config.codexBin === 'string' ? config.codexBin : undefined,
      cwd: config.workspaceRoot,
      logDir: join(config.stateDir, 'codex-tasks'),
      logger,
    })
    codexRef.client = client
    codexRef.error = undefined
    codexRef.binPath = client.binPath ?? client.codexBin ?? codexRef.binPath
    return client
  } catch (error) {
    codexRef.client = null
    codexRef.error = `codex-client-unavailable: ${String(error?.message ?? error)}`
    logger.warn?.(`agent-bridge: ${codexRef.error}`)
    return undefined
  }
}

export function apply(ctx, config = {}) {
  const logger = ctx.logger ?? console
  const stateDir = typeof config.stateDir === 'string' && config.stateDir.length > 0 ? config.stateDir : join(homedir(), '.dsh', 'agent-bridge')
  const resolvedConfig = {
    prefix: normalizePrefix(config.prefix ?? '/agent-bridge'),
    stateDir,
    workspaceRoot: typeof config.workspaceRoot === 'string' && config.workspaceRoot.length > 0 ? config.workspaceRoot : process.cwd(),
    autoNotify: config.autoNotify === true,
    maxWaitMs: config.maxWaitMs,
    taskTimeoutMs: config.taskTimeoutMs,
    codexBin: config.codexBin,
  }

  const store = createStore({ stateDir, logger })
  const codexRef = { client: null, error: 'codex-client-not-loaded', binPath: config.codexBin }
  const bridge = createBridgeServer({
    ctx,
    store,
    config: resolvedConfig,
    codexRef,
    logger,
    version: VERSION,
  })

  ctx.effect(() => {
    void bridge
      .init()
      .then(async () => {
        const origin = resolveOrigin(ctx)
        if (origin !== undefined) {
          await store.writeEndpoint({
            protocol: 1,
            baseUrl: `${origin}${resolvedConfig.prefix}`,
            tokenPath: store.tokenPath,
            workspaceRoot: resolvedConfig.workspaceRoot,
            pluginVersion: VERSION,
            updatedAt: isoNow(),
          })
        }
        await loadCodexClient(resolvedConfig, ctx, codexRef, logger)
      })
      .catch((error) => logger.warn?.(`agent-bridge: initialisation failed: ${String(error?.stack ?? error)}`))

    const disposers = []

    // Register the DSH-side tools first: a failure there must never leave a
    // half-registered route behind (a leaked prefix route would make every
    // later activation fail with "duplicate prefix route" until a host restart).
    try {
      const toolDisposers = registerTools(ctx, {
        bridge,
        codexRef,
        store,
        workspaceRoot: resolvedConfig.workspaceRoot,
      })
      disposers.push(...toolDisposers, ...registerLifecycleTools(ctx, bridge))
    } catch (error) {
      codexRef.error = `tool-registration-failed: ${String(error?.message ?? error)}`
      logger.warn?.(`agent-bridge: ${codexRef.error}`)
    }

    try {
      disposers.push(
        ctx.webServer.register({
          kind: 'prefix',
          path: resolvedConfig.prefix,
          handler: bridge.handle,
        }),
      )
    } catch (error) {
      bridge.routeError = `route-registration-failed: ${String(error?.message ?? error)}`
      logger.warn?.(`agent-bridge: ${bridge.routeError}; Codex → DSH delivery stays unavailable until the host is restarted.`)
    }

    return () => {
      for (const dispose of disposers.reverse()) {
        try {
          dispose()
        } catch {
          /* already disposed */
        }
      }
      bridge.dispose()
      void store.close()
    }
  }, 'agent-bridge: tools, HTTP route, durable state')

  logger.info?.(`agent-bridge: mounted at ${resolvedConfig.prefix} (state: ${stateDir})`)
}

export default { name, inject, apply }



