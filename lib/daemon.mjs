/**
 * Daemon transport: one place that knows how to talk to the local Kimi WebBridge
 * daemon, how long to wait, and how to report a timeout honestly.
 *
 * Daemon contract (v2.x):
 *   POST /command  { action, args, session }
 *   success: { ok:true, data:{...} } | { ok:true, ...result }
 *   failure: { ok:false, error:{ code, message } }   (HTTP 502)
 *
 * Every call carries a client-side budget. A timed-out call is reported as
 * `{ timedOut:true, unknownEffects:<bool> }` and is NEVER retried here: the
 * daemon may have applied the effect after the client gave up (documented
 * `mayHaveLateEffects` semantics), so a blind retry is a duplicate write.
 */
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { homedir } from 'node:os'

export const DEFAULT_TIMEOUT_MS = 60_000

/** Per-action client-side budgets (ms). Anything absent uses `timeoutMs`. */
export const ACTION_BUDGETS = Object.freeze({
  // `navigate` waits on the extension's own load callback: on some browsers the
  // new-tab path never answers (a 30 s timer wrapping a 300 s CDP call), so it
  // gets a short budget and an actionable hint instead of a 5-minute hang.
  navigate: 15_000,
  snapshot: 20_000,
  evaluate: 20_000,
  obs_evaluate: 15_000,
  act_check: 10_000,
  act_input: 8_000,
  list_tabs: 8_000,
  find_tab: 8_000,
  cdp: 10_000,
})

export function resolveBudget(action, timeoutMs, override) {
  if (typeof override === 'number' && override > 0) return override
  return ACTION_BUDGETS[action] ?? timeoutMs
}

/** Error subclass so the caller can tell "daemon down" from "daemon said no". */
export class ConnectionError extends Error {}

/** Parse a daemon error envelope out of a raw body, if it is one. */
export function parseErrorBody(raw) {
  try {
    const body = JSON.parse(raw)
    if (body && body.ok === false && body.error) {
      return { code: body.error.code ?? 'error', message: body.error.message ?? raw.slice(0, 500) }
    }
  } catch { /* not JSON */ }
  return null
}

/**
 * @param {object} cfg
 * @param {string} cfg.daemonUrl
 * @param {string} cfg.daemonBin
 * @param {number} cfg.timeoutMs
 * @param {boolean} cfg.autostart
 * @param {boolean} cfg.mock
 * @param {(action: string, args: object) => object} [cfg.mockCall]
 */
export function createDaemonClient(cfg) {
  /**
   * Call one daemon action.
   * @returns {Promise<{ok: boolean, data?: any, error?: {code:string,message:string},
   *   ms: number, timedOut: boolean, budgetMs: number, unknownEffects: boolean, action: string}>}
   */
  async function call(action, args, session, { budgetMs, mutating = false } = {}) {
    const budget = resolveBudget(action, cfg.timeoutMs, budgetMs)
    const started = Date.now()
    if (cfg.mock) {
      const data = cfg.mockCall ? cfg.mockCall(action, args ?? {}, session) : {}
      const ok = !(data && data.__error)
      return {
        ok, data: ok ? data : undefined,
        error: ok ? undefined : { code: 'mock_error', message: String(data.__error) },
        ms: Date.now() - started, timedOut: false, budgetMs: budget, unknownEffects: false, action,
      }
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), budget)
    let raw = ''
    let status = 0
    let transportError = null
    try {
      const res = await fetch(`${cfg.daemonUrl}/command`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, args, session }),
        signal: controller.signal,
      })
      status = res.status
      raw = await res.text()
    } catch (error) {
      transportError = error
    } finally {
      clearTimeout(timer)
    }
    const ms = Date.now() - started

    if (transportError) {
      if (controller.signal.aborted) {
        return {
          ok: false,
          error: {
            code: 'timeout',
            message: `${action} exceeded its ${budget} ms client budget — the daemon never answered. ` +
              'Treat the effect as UNKNOWN and re-read page state before retrying.',
          },
          ms, timedOut: true, budgetMs: budget, unknownEffects: mutating, action,
        }
      }
      const code = transportError.cause?.code ?? transportError.code ?? 'transport'
      const message = `kimi-webbridge daemon unreachable at ${cfg.daemonUrl} (${code})`
      const err = new ConnectionError(message)
      err.code = 'unreachable'
      throw err
    }

    const parsedError = parseErrorBody(raw)
    if (parsedError) {
      return { ok: false, error: parsedError, ms, timedOut: false, budgetMs: budget, unknownEffects: false, action }
    }
    if (status < 200 || status >= 300) {
      return {
        ok: false,
        error: { code: `http_${status}`, message: raw.slice(0, 500) },
        ms, timedOut: false, budgetMs: budget, unknownEffects: false, action,
      }
    }
    let body
    try {
      body = JSON.parse(raw)
    } catch {
      return { ok: true, data: { raw: raw.slice(0, 100_000) }, ms, timedOut: false, budgetMs: budget, unknownEffects: false, action }
    }
    if (body && typeof body === 'object') {
      const { ok: _ok, error: _error, ...rest } = body
      return {
        ok: true,
        data: rest.data !== undefined ? rest.data : rest,
        ms, timedOut: false, budgetMs: budget, unknownEffects: false, action,
      }
    }
    return { ok: true, data: { raw }, ms, timedOut: false, budgetMs: budget, unknownEffects: false, action }
  }

  /** Autostart-on-unreachable wrapper (existing behaviour, unchanged). */
  async function callWithAutostart(action, args, session, options) {
    try {
      return await call(action, args, session, options)
    } catch (error) {
      if (cfg.autostart && error instanceof ConnectionError) {
        process.stderr.write(`[webbridge-mcp] daemon unreachable; starting ${cfg.daemonBin} ...\n`)
        try {
          spawn(cfg.daemonBin, ['start'], { detached: true, stdio: 'ignore' }).unref()
          await sleep(1800)
        } catch (startError) {
          process.stderr.write(`[webbridge-mcp] autostart failed: ${startError.message}\n`)
        }
        return await call(action, args, session, options)
      }
      throw error
    }
  }

  /** Real status surface is the CLI (`kimi-webbridge status` prints JSON). */
  async function status() {
    if (cfg.mock) return { running: true, extension_connected: true, mock: true, version: 'mock' }
    return new Promise((resolve, reject) => {
      const child = spawn(cfg.daemonBin, ['status'], { stdio: ['ignore', 'pipe', 'pipe'] })
      const timeout = setTimeout(() => {
        child.kill()
        reject(new Error('kimi-webbridge status timed out'))
      }, 5000)
      let out = '', err = ''
      child.stdout.on('data', (d) => { out += d })
      child.stderr.on('data', (d) => { err += d })
      child.on('error', (e) => {
        clearTimeout(timeout)
        reject(new ConnectionError(`cannot run ${cfg.daemonBin}: ${e.message}`))
      })
      child.on('close', (code) => {
        clearTimeout(timeout)
        if (code === 0) {
          try { resolve(JSON.parse(out)) } catch { reject(new Error(`kimi-webbridge status returned non-JSON: ${out.slice(0, 500)}`)) }
        } else {
          reject(new Error(`kimi-webbridge status exited ${code}: ${err.slice(0, 500)}`))
        }
      })
    })
  }

  return { call, callWithAutostart, status, cfg }
}

/** Default env-driven configuration (kept identical to the pre-1.1 contract). */
export function readConfig(env = process.env) {
  return {
    daemonUrl: (env.WEBBRIDGE_DAEMON_URL || 'http://127.0.0.1:10086').replace(/\/+$/, ''),
    daemonBin: env.WEBBRIDGE_DAEMON_BIN || `${homedir()}/.kimi-webbridge/bin/kimi-webbridge`,
    timeoutMs: Number(env.WEBBRIDGE_MCP_TIMEOUT_MS || DEFAULT_TIMEOUT_MS),
    autostart: (env.WEBBRIDGE_MCP_AUTOSTART ?? '1') !== '0',
    defaultSession: env.WEBBRIDGE_MCP_DEFAULT_SESSION || 'webbridge-mcp',
    mock: (env.WEBBRIDGE_MCP_MOCK ?? '0') === '1',
    debug: (env.WEBBRIDGE_MCP_DEBUG ?? '0') === '1',
    obsMaxChars: Number(env.WEBBRIDGE_MCP_OBS_MAX_CHARS || 4000),
    obsMaxElements: Number(env.WEBBRIDGE_MCP_OBS_MAX_ELEMENTS || 120),
    obsTextChars: Number(env.WEBBRIDGE_MCP_OBS_TEXT_CHARS || 1200),
    obsTimeoutMs: Number(env.WEBBRIDGE_MCP_OBS_TIMEOUT_MS || ACTION_BUDGETS.obs_evaluate),
    actCheckTimeoutMs: Number(env.WEBBRIDGE_MCP_ACT_TIMEOUT_MS || ACTION_BUDGETS.act_check),
    actInputTimeoutMs: Number(env.WEBBRIDGE_MCP_ACT_INPUT_TIMEOUT_MS || ACTION_BUDGETS.act_input),
  }
}
