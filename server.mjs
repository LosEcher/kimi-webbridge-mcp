#!/usr/bin/env node
/**
 * kimi-webbridge-mcp — MCP stdio server exposing the local Kimi WebBridge
 * daemon (http://127.0.0.1:10086/command) as Model Context Protocol tools.
 *
 * Zero dependencies: plain Node >= 18, newline-delimited JSON-RPC 2.0 over
 * stdio (the same framing Claude Code / Codex / DSH mcp-client use).
 *
 * Daemon contract (v1.11.x):
 *   POST /command  { action, args, session } -> JSON
 *   success: { ok: true, ...result }  |  { ok: true, data: {...} }
 *   failure: { ok: false, error: { code, message } }  (HTTP 502)
 *
 * Environment:
 *   WEBBRIDGE_DAEMON_URL          daemon base URL          (default http://127.0.0.1:10086)
 *   WEBBRIDGE_DAEMON_BIN          daemon CLI for autostart (default ~/.kimi-webbridge/bin/kimi-webbridge)
 *   WEBBRIDGE_MCP_TIMEOUT_MS      per-call timeout         (default 60000)
 *   WEBBRIDGE_MCP_AUTOSTART       '1' start daemon on connection failure (default '1')
 *   WEBBRIDGE_MCP_DEFAULT_SESSION default tab-group session (default webbridge-mcp)
 *   WEBBRIDGE_MCP_MOCK            '1' canned responses, no daemon/browser (testing)
 */

import { createInterface } from 'node:readline'
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { homedir } from 'node:os'

const PROTOCOL_VERSION = '2024-11-05'
const MAX_RESULT_TEXT = 1_000_000
const MAX_ERROR_TEXT = 500

const cfg = {
  daemonUrl: (process.env.WEBBRIDGE_DAEMON_URL || 'http://127.0.0.1:10086').replace(/\/+$/, ''),
  daemonBin: process.env.WEBBRIDGE_DAEMON_BIN || `${homedir()}/.kimi-webbridge/bin/kimi-webbridge`,
  timeoutMs: Number(process.env.WEBBRIDGE_MCP_TIMEOUT_MS || 60_000),
  autostart: (process.env.WEBBRIDGE_MCP_AUTOSTART ?? '1') !== '0',
  defaultSession: process.env.WEBBRIDGE_MCP_DEFAULT_SESSION || 'webbridge-mcp',
  mock: (process.env.WEBBRIDGE_MCP_MOCK ?? '0') === '1',
}

// ── Tool catalog ────────────────────────────────────────────────────────────
// Session rules (from the kimi-webbridge skill): one task = one session = one
// tab group. Pass the same session on every call of a task; name it after the
// task. group_title (human label, user's language) goes on the FIRST navigate.

const SESSION_ARG = {
  type: 'string',
  description: 'Tab-group session name. One task = one session; pass the same value on every call of a task. Defaults to a stable server-level session.',
}

const TOOLS = [
  {
    name: 'navigate',
    description:
      'Open a URL in the user\u2019s real browser (Kimi WebBridge) and make it the current tab. First call of a task: pass newTab:true and a human-readable group_title in the user\u2019s language. Omit newTab to send the current tab to the URL.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Full URL to open.' },
        newTab: { type: 'boolean', description: 'Open in a new tab (default false). Use true when pages should coexist.' },
        group_title: { type: 'string', description: 'Visible label for this task\u2019s tab group; set on the first navigate of a task, in the user\u2019s language.' },
        session: SESSION_ARG,
      },
      required: ['url'],
    },
  },
  {
    name: 'find_tab',
    description:
      'Re-select a tab this session opened. Pass the exact full URL from list_tabs/navigate (a bare root domain may miss a www.* tab). active:true borrows the tab the user is currently viewing (operates it in place, borrowed:true).',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Exact full URL of the tab to select.' },
        active: { type: 'boolean', description: 'Borrow the tab the user is currently viewing (default false).' },
        session: SESSION_ARG,
      },
      required: ['url'],
    },
  },
  {
    name: 'snapshot',
    description:
      'Read the current tab\u2019s accessibility tree (text) to inspect the page and locate elements. Returns @e refs usable as selectors for click/fill — prefer them over hand-written CSS. Use after navigate and after page changes.',
    inputSchema: { type: 'object', properties: { session: SESSION_ARG } },
  },
  {
    name: 'click',
    description: 'Click an element in the current tab. selector: an @e ref from snapshot or a CSS selector. Use the submit button to submit forms (no Enter tool).',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: '@e ref (preferred) or CSS selector.' },
        session: SESSION_ARG,
      },
      required: ['selector'],
    },
  },
  {
    name: 'fill',
    description:
      'Fill an input/textarea or [contenteditable] rich editor (ProseMirror/TipTap/Lexical/Slate). Clear-and-insert: existing content is replaced; append by reading the current value via evaluate, concatenating, then filling.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: '@e ref (preferred) or CSS selector.' },
        value: { type: 'string', description: 'Text to insert.' },
        session: SESSION_ARG,
      },
      required: ['selector', 'value'],
    },
  },
  {
    name: 'evaluate',
    description:
      'Run JavaScript in the current tab (async/await supported). Wrap declarations in an IIFE so repeated calls do not hit redeclare errors; keep return payloads compact (JSON.stringify without formatting).',
    inputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'JavaScript source to evaluate.' },
        session: SESSION_ARG,
      },
      required: ['code'],
    },
  },
  {
    name: 'cdp',
    description: 'Raw chrome.debugger (CDP) passthrough. Low-level escape hatch when the other tools do not cover a case (e.g. trusted input events). method: CDP domain.method, params: method arguments.',
    inputSchema: {
      type: 'object',
      properties: {
        method: { type: 'string', description: 'CDP method, e.g. Page.captureScreenshot.' },
        params: { type: 'object', description: 'CDP method arguments.' },
        session: SESSION_ARG,
      },
      required: ['method'],
    },
  },
  {
    name: 'screenshot',
    description:
      'Screenshot the current tab (or a single element via selector). Returns a LOCAL FILE PATH (not base64) — open the path with the Read tool to see the image. format png|jpeg, quality 0-100.',
    inputSchema: {
      type: 'object',
      properties: {
        format: { type: 'string', enum: ['png', 'jpeg'], description: 'Image format (default png).' },
        quality: { type: 'integer', minimum: 0, maximum: 100, description: 'JPEG quality.' },
        selector: { type: 'string', description: '@e ref or CSS selector to capture just that element.' },
        path: { type: 'string', description: 'Optional output path (written verbatim, existing file overwritten).' },
        session: SESSION_ARG,
      },
    },
  },
  {
    name: 'network',
    description: 'Inspect network activity of the current tab. cmd: start begins capture, stop ends it, list returns captured entries (optional filter), detail returns one request/response by requestId.',
    inputSchema: {
      type: 'object',
      properties: {
        cmd: { type: 'string', enum: ['start', 'stop', 'list', 'detail'], description: 'Operation to run.' },
        filter: { type: 'string', description: 'URL substring filter for list.' },
        requestId: { type: 'string', description: 'Request id for detail.' },
        session: SESSION_ARG,
      },
      required: ['cmd'],
    },
  },
  {
    name: 'upload',
    description: 'Upload files to an <input type="file"> in the current tab. files: absolute local paths.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: '@e ref or CSS selector of the file input.' },
        files: { type: 'array', items: { type: 'string' }, description: 'Absolute paths of files to upload.' },
        session: SESSION_ARG,
      },
      required: ['selector', 'files'],
    },
  },
  {
    name: 'save_as_pdf',
    description: 'Render the current page to PDF and return a LOCAL FILE PATH (open with the Read tool). paper_format letter|a4|legal|tabloid; scale 0-1 range; decoded PDF cap is 100 MB.',
    inputSchema: {
      type: 'object',
      properties: {
        paper_format: { type: 'string', enum: ['letter', 'a4', 'legal', 'tabloid'], description: 'Paper size (default letter).' },
        landscape: { type: 'boolean', description: 'Landscape orientation (default false).' },
        scale: { type: 'number', description: 'Scale factor (default 1.0).' },
        print_background: { type: 'boolean', description: 'Keep background colors (default true).' },
        path: { type: 'string', description: 'Optional output path.' },
        session: SESSION_ARG,
      },
    },
  },
  {
    name: 'list_tabs',
    description: 'List the tabs in the current session (tabId, url, title, active, groupTitle). Use to inspect state and recover exact URLs for find_tab; never re-create a tab that already exists.',
    inputSchema: { type: 'object', properties: { session: SESSION_ARG } },
  },
  {
    name: 'close_tab',
    description: 'Close the current tab of the session.',
    inputSchema: { type: 'object', properties: { session: SESSION_ARG } },
  },
  {
    name: 'close_session',
    description: 'Close ALL tabs of the session (returns the closed count). Call only when the user explicitly asks to close the task\u2019s tabs — never automatically.',
    inputSchema: { type: 'object', properties: { session: SESSION_ARG } },
  },
  {
    name: 'webbridge_status',
    description:
      'Check the WebBridge daemon and browser-extension state. Call this first when another tool fails with a connection error or \u201cno extension connected\u201d. If the daemon is down this server tries to start it once (WEBBRIDGE_MCP_AUTOSTART).',
    inputSchema: { type: 'object', properties: {} },
  },
]

// ── Daemon transport ────────────────────────────────────────────────────────

function parseErrorBody(raw) {
  try {
    const body = JSON.parse(raw)
    if (body && body.ok === false && body.error) {
      return `webbridge ${body.error.code ?? 'error'}: ${body.error.message ?? raw.slice(0, MAX_ERROR_TEXT)}`
    }
  } catch { /* not JSON */ }
  return null
}

async function callDaemon(action, args, session) {
  if (cfg.mock) return mockResult(action, args)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs)
  try {
    let res
    try {
      res = await fetch(`${cfg.daemonUrl}/command`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, args, session }),
        signal: controller.signal,
      })
    } catch (error) {
      throw new ConnectionError(`kimi-webbridge daemon unreachable at ${cfg.daemonUrl} (${error.cause?.code ?? error.message})`)
    }
    const raw = await res.text()
    const parsed = parseErrorBody(raw)
    if (parsed) throw new Error(parsed)
    if (!res.ok) throw new Error(`kimi-webbridge daemon HTTP ${res.status}: ${raw.slice(0, MAX_ERROR_TEXT)}`)
    try {
      const body = JSON.parse(raw)
      if (body && typeof body === 'object') {
        const { ok, error, ...rest } = body
        return rest.data !== undefined ? rest.data : rest
      }
      return { raw }
    } catch {
      return { raw: raw.slice(0, MAX_RESULT_TEXT) }
    }
  } finally {
    clearTimeout(timer)
  }
}

class ConnectionError extends Error {}

/** Real status surface is the CLI (`kimi-webbridge status` prints JSON) — the
 * daemon has no health endpoint and no webbridge_status command action. */
async function daemonStatus() {
  if (cfg.mock) return mockResult('webbridge_status', {})
  return new Promise((resolve, reject) => {
    const child = spawn(cfg.daemonBin, ['status'], { stdio: ['ignore', 'pipe', 'pipe'] })
    const timeout = setTimeout(() => {
      child.kill()
      reject(new Error('kimi-webbridge status timed out'))
    }, 5000)
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { err += d })
    child.on('error', (e) => {
      clearTimeout(timeout)
      reject(new ConnectionError(`cannot run ${cfg.daemonBin}: ${e.message}`))
    })
    child.on('close', (code) => {
      clearTimeout(timeout)
      if (code === 0) {
        try {
          resolve(JSON.parse(out))
        } catch {
          reject(new Error(`kimi-webbridge status returned non-JSON: ${out.slice(0, MAX_ERROR_TEXT)}`))
        }
      } else {
        reject(new Error(`kimi-webbridge status exited ${code}: ${err.slice(0, MAX_ERROR_TEXT)}`))
      }
    })
  })
}

async function callWithAutostart(action, args, session) {
  try {
    return await callDaemon(action, args, session)
  } catch (error) {
    if (cfg.autostart && error instanceof ConnectionError) {
      process.stderr.write(`[webbridge-mcp] daemon unreachable; starting ${cfg.daemonBin} ...\n`)
      try {
        spawn(cfg.daemonBin, ['start'], { detached: true, stdio: 'ignore' }).unref()
        await sleep(1800)
      } catch (startError) {
        process.stderr.write(`[webbridge-mcp] autostart failed: ${startError.message}\n`)
      }
      return await callDaemon(action, args, session) // second attempt, errors propagate
    }
    throw error
  }
}

// ── Mock mode (WEBBRIDGE_MCP_MOCK=1): deterministic responses, no daemon ────

function mockResult(action, args) {
  const a = args ?? {}
  const results = {
    navigate: () => ({ success: true, url: a.url, tabId: 'mock-tab-1', mock: true }),
    find_tab: () => ({ success: true, url: a.url, tabId: 'mock-tab-1', borrowed: Boolean(a.active), mock: true }),
    snapshot: () => ({ url: 'about:blank', title: 'mock', tree: '<html><body><button @e1>Example</button></body></html>', mock: true }),
    click: () => ({ success: true, tag: 'button', text: 'Example', mock: true }),
    fill: () => ({ success: true, tag: 'input', mode: 'value', mock: true }),
    evaluate: () => ({ type: 'string', value: 'mock-eval-result', mock: true }),
    cdp: () => ({ mock: true }),
    screenshot: () => ({ format: a.format ?? 'png', path: '/tmp/webbridge-mock.png', sizeBytes: 0, mimeType: 'image/png', mock: true }),
    network: () => ({ mock: true, events: [] }),
    upload: () => ({ success: true, fileCount: Array.isArray(a.files) ? a.files.length : 0, mock: true }),
    save_as_pdf: () => ({ path: '/tmp/webbridge-mock.pdf', sizeBytes: 0, mimeType: 'application/pdf', pageTitle: 'mock', mock: true }),
    list_tabs: () => ({ success: true, tabs: [{ tabId: 'mock-tab-1', url: 'about:blank', title: 'mock', active: true, groupTitle: 'mock' }], mock: true }),
    close_tab: () => ({ success: true, closed: true, mock: true }),
    close_session: () => ({ success: true, closed: 1, mock: true }),
    webbridge_status: () => ({ running: true, extension_connected: true, mock: true, version: 'v1.11.5' }),
  }
  const make = results[action]
  if (!make) throw new Error(`Unknown webbridge action: ${action}`)
  return make()
}

// ── MCP JSON-RPC over stdio ─────────────────────────────────────────────────

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result }
}
function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } }
}

async function handle(message) {
  // Notifications and malformed messages get no reply.
  if (message.id === undefined || typeof message.id === 'object' || message.id === null) return null
  if (message.jsonrpc !== '2.0') return null

  if (message.method === 'initialize') {
    return rpcResult(message.id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: 'kimi-webbridge-mcp', version: '1.0.0' },
    })
  }
  if (message.method === 'ping') return rpcResult(message.id, {})
  if (message.method === 'tools/list') return rpcResult(message.id, { tools: TOOLS })
  if (message.method === 'tools/call') {
    const name = typeof message.params?.name === 'string' ? message.params.name : ''
    const args = (message.params?.arguments && typeof message.params.arguments === 'object')
      ? message.params.arguments
      : {}
    if (!name) return rpcError(message.id, -32602, 'tools/call requires params.name')
    const session = typeof args.session === 'string' && args.session.length > 0 ? args.session : cfg.defaultSession
    const { session: _drop, ...toolArgs } = args
    try {
      const value = name === 'webbridge_status'
        ? await daemonStatus()
        : await callWithAutostart(name, toolArgs, session)
      return rpcResult(message.id, { content: [{ type: 'text', text: JSON.stringify(value) }] })
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error)
      return rpcResult(message.id, {
        content: [{ type: 'text', text: text.slice(0, MAX_RESULT_TEXT) }],
        isError: true,
      })
    }
  }
  return rpcError(message.id, -32601, `Method not found: ${message.method ?? '<missing>'}`)
}

// ── Main loop ───────────────────────────────────────────────────────────────

process.stderr.write(`[webbridge-mcp] ready (daemon: ${cfg.daemonUrl}${cfg.mock ? ' [MOCK]' : ''}, session default: ${cfg.defaultSession})\n`)

const lines = createInterface({ input: process.stdin })
for await (const line of lines) {
  if (!line.trim()) continue
  let response
  try {
    const message = JSON.parse(line)
    response = await handle(message)
  } catch {
    response = rpcError(0, -32700, 'Parse error')
  }
  if (response) process.stdout.write(`${JSON.stringify(response)}\n`)
}
