#!/usr/bin/env node
/**
 * kimi-webbridge-mcp — MCP stdio server exposing the local Kimi WebBridge
 * daemon (http://127.0.0.1:10086/command) as Model Context Protocol tools.
 *
 * Zero dependencies: plain Node >= 18, newline-delimited JSON-RPC 2.0 over
 * stdio (the same framing Claude Code / Codex / DSH mcp-client use).
 *
 * Tool families
 *   fast loop  obs / act / open_tab — one atomic observation, guarded execution,
 *              and a tab lifecycle that never depends on `navigate`.
 *   legacy     navigate / snapshot / click / fill / evaluate / cdp / screenshot /
 *              network / upload / save_as_pdf / list_tabs / close_tab /
 *              close_session / find_tab / webbridge_status — unchanged, still
 *              the escape hatch for frames, shadow DOM, dialogs and uploads.
 *
 * Environment:
 *   WEBBRIDGE_DAEMON_URL             daemon base URL           (default http://127.0.0.1:10086)
 *   WEBBRIDGE_DAEMON_BIN             daemon CLI for autostart  (default ~/.kimi-webbridge/bin/kimi-webbridge)
 *   WEBBRIDGE_MCP_TIMEOUT_MS         default per-call budget   (default 60000)
 *   WEBBRIDGE_MCP_AUTOSTART          '1' start the daemon on connection failure (default '1')
 *   WEBBRIDGE_MCP_DEFAULT_SESSION    default tab-group session (default webbridge-mcp)
 *   WEBBRIDGE_MCP_MOCK               '1' canned/fake daemon, no browser (testing)
 *   WEBBRIDGE_MCP_DEBUG              '1' per-step diagnostics on stderr
 *   WEBBRIDGE_MCP_OBS_MAX_CHARS      obs model-facing char budget (default 4000)
 *   WEBBRIDGE_MCP_OBS_MAX_ELEMENTS   obs element cap              (default 120)
 *   WEBBRIDGE_MCP_OBS_TEXT_CHARS     obs visible-text cap         (default 1200)
 *   WEBBRIDGE_MCP_OBS_TIMEOUT_MS     obs page read budget         (default 15000)
 *   WEBBRIDGE_MCP_ACT_TIMEOUT_MS     act precondition-check budget (default 10000)
 *   WEBBRIDGE_MCP_ACT_INPUT_TIMEOUT_MS  act input/verify budget  (default 8000)
 */

import { createInterface } from 'node:readline'
import { readConfig, createDaemonClient } from './lib/daemon.mjs'
import { createObsStore } from './lib/refs.mjs'
import { createSessionGuard } from './lib/sessions.mjs'
import { createObsHandler } from './lib/obs.mjs'
import { createActHandler } from './lib/act.mjs'
import { openTab } from './lib/tabs.mjs'
import { createMockCall } from './lib/mock-daemon.mjs'

const PROTOCOL_VERSION = '2024-11-05'
const MAX_RESULT_TEXT = 1_000_000
const MAX_ERROR_TEXT = 500

const cfg = readConfig()

// ── Tool catalog ────────────────────────────────────────────────────────────
// Session rules: one task = one session = one tab group. Pass the same session
// on every call of a task; name it after the task.

const SESSION_ARG = {
  type: 'string',
  description: 'Tab-group session name. One task = one session; pass the same value on every call of a task. Defaults to a stable server-level session.',
}

const TOOLS = [
  {
    name: 'obs',
    description:
      'Observe the current tab in ONE round trip: a compact indexed element table (ref/kind/role/name/value) plus visible text and scroll state. ' +
      'Each element gets an opaque ref (e.g. o3:17) that stays valid while that element keeps its meaning — prefer acting on these refs over CSS selectors. ' +
      'The payload is budget-capped (default 4000 chars) and truncation is reported in `omitted`/`truncated`. ' +
      'Prefer obs over snapshot: snapshot returns the full accessibility tree (tens of thousands of characters) and its @e refs are positional.',
    inputSchema: {
      type: 'object',
      properties: {
        max_chars: { type: 'integer', description: 'Model-facing character budget (default 4000).' },
        max_elements: { type: 'integer', description: 'Maximum elements to list (default 120).' },
        text_chars: { type: 'integer', description: 'Maximum visible-text characters (default 1200).' },
        include_rect: { type: 'boolean', description: 'Include each element rect (default false; geometry is re-resolved at act time anyway).' },
        keep_alive: { type: 'boolean', description: 'Set false to skip arming focus emulation on a background tab (default: arm it when the page reports itself hidden).' },
        session: SESSION_ARG,
      },
    },
  },
  {
    name: 'act',
    description:
      'Act on a ref from obs, with a guard: before dispatching anything the element is re-checked in one page call (still attached? enabled? visible? on-screen? uncovered? still the same role/name/value/surrounding text?). ' +
      'If anything changed, act REFUSES and dispatches NO input, returning stale:true + no_input_dispatched:true + the exact change (plus a fresh observation). ' +
      'If it still matches, real trusted input is dispatched via CDP (Input.dispatchMouseEvent / Input.insertText / Input.dispatchKeyEvent) and delivery is verified. ' +
      'Geometry is always re-resolved at act time, so an element that merely moved is still hit. ' +
      'kind: click (default), fill (needs text), press (needs key: Enter/Tab/Escape/ArrowUp/ArrowDown/Backspace/Delete/Space), select (needs value).',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Element ref from obs, e.g. o3:17.' },
        kind: { type: 'string', enum: ['click', 'fill', 'press', 'select'], description: 'Action kind (default click).' },
        text: { type: 'string', description: 'Text for kind=fill ("" clears the field).' },
        key: { type: 'string', enum: ['Enter', 'Tab', 'Escape', 'ArrowDown', 'ArrowUp', 'Backspace', 'Delete', 'Space'], description: 'Key for kind=press.' },
        value: { type: 'string', description: 'Option value for kind=select.' },
        settle_ms: { type: 'integer', description: 'Bounded settle after dispatch, in ms (default 40).' },
        verify_delivery: { type: 'boolean', description: 'Verify that the pointer event actually reached the intended element (default true).' },
        refresh: { type: 'boolean', description: 'On a drift/detached refusal, include a fresh observation in the response (default true).' },
        session: SESSION_ARG,
      },
      required: ['ref'],
    },
  },
  {
    name: 'open_tab',
    description:
      'Open a URL in a background tab and make it the session\u2019s working tab, WITHOUT using navigate. ' +
      'navigate waits on the extension\u2019s load callback (measured p50 24 s, and it can hang unbounded), so this is the reliable way to start a task. ' +
      'The tab is created by the browser (cdp Target.createTarget, milliseconds), identified by tab-id diff (never by hostname matching), kept in the background so the user\u2019s visible tab does not switch, and armed for keep-alive. ' +
      'Returns ready/ready_state/waited_ms or an honest failure with created:true when the browser made a tab the session could not bind.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to open (http/https).' },
        reuse: { type: 'boolean', description: 'Reuse a matching tab already in this session (default true).' },
        can_create: { type: 'boolean', description: 'Allow the last-resort background tab creation when the session owns no tab (default true). Set false to forbid creating tabs entirely.' },
        ready_timeout_ms: { type: 'integer', description: 'Readiness budget in ms (default 5000).' },
        anchor: { type: 'string', description: 'URL of a tab to borrow as the CDP anchor when the session owns no tab (default: discover the foreground tab on macOS).' },
        session: SESSION_ARG,
      },
      required: ['url'],
    },
  },
  {
    name: 'navigate',
    description:
      'Open a URL in the user\u2019s real browser (Kimi WebBridge) and make it the current tab. ' +
      'WARNING: on some browsers the new-tab path never answers (the extension wraps a 30 s timer around a 300 s CDP call), so this call is budgeted and may report a timeout — prefer open_tab for opening pages. ' +
      'Omit newTab to send the already-borrowed tab to the URL (that path is fast and safe).',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Full URL to open.' },
        newTab: { type: 'boolean', description: 'Open in a new tab (default false). Prefer open_tab when true.' },
        group_title: { type: 'string', description: 'Visible label for this task\u2019s tab group; set on the first navigate of a task, in the user\u2019s language.' },
        session: SESSION_ARG,
      },
      required: ['url'],
    },
  },
  {
    name: 'find_tab',
    description:
      'Re-select a tab this session opened. Pass the exact full URL from list_tabs/open_tab. ' +
      'Note: matching is by HOSTNAME, so a same-host tab can be selected by mistake — verify the returned url/tabId. active:true borrows the tab the user is currently viewing (operates it in place, borrowed:true).',
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
      'Read the current tab\u2019s accessibility tree (text) — the full-tree escape hatch, useful for iframes/shadow DOM/canvas that obs does not reach. ' +
      'Returns @e refs usable as selectors for click/fill, but those refs are POSITIONAL and are renumbered by every snapshot: never reuse an @e ref across snapshots. Prefer obs + act.',
    inputSchema: { type: 'object', properties: { session: SESSION_ARG } },
  },
  {
    name: 'click',
    description: 'Click an element in the current tab (legacy path, no guard). selector: an @e ref from snapshot or a CSS selector. Prefer obs + act, which refuse stale targets instead of silently mis-clicking.',
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
      'Fill an input/textarea or [contenteditable] rich editor (legacy path, no guard). Clear-and-insert: existing content is replaced. Prefer obs + act kind=fill, which verifies the value landed.',
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
      'Run JavaScript in the current tab (async/await supported). Wrap declarations in an IIFE so repeated calls do not hit redeclare errors; keep return payloads compact (JSON.stringify without formatting). ' +
      'Note: a background tab throttles its own timers/rAF, so do not run long in-page loops — obs/act already arm focus emulation to avoid that.',
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
    description: 'Raw chrome.debugger (CDP) passthrough. Low-level escape hatch when the other tools do not cover a case (e.g. trusted input events). method: CDP domain.method, params: method arguments. Requires the session to already own a tab.',
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
    description: 'Close the current (working) tab of the session. Use only on tabs this session opened — a borrowed user tab is still the user\u2019s tab.',
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

// ── Wiring ──────────────────────────────────────────────────────────────────

const daemon = createDaemonClient({
  ...cfg,
  mockCall: cfg.mock ? createMockCall() : undefined,
})
const store = createObsStore()
const guard = createSessionGuard()
const obs = createObsHandler({ call: daemon.call, store, cfg, guard })
const act = createActHandler({ call: daemon.call, store, cfg, obs, guard })

/** Tools implemented by this server itself (not a straight daemon passthrough). */
async function callNative(name, args, session) {
  if (name === 'obs') return obs(args, session)
  if (name === 'act') return act(args, session)
  if (name === 'open_tab') {
    return openTab(daemon.call, session, {
      url: args.url,
      reuse: args.reuse !== false,
      canCreate: args.can_create !== false,
      readyTimeoutMs: args.ready_timeout_ms ?? 5000,
      anchorUrl: args.anchor,
      userTabProbe: cfg.mock ? () => ({ via: 'mock', url: 'https://mock.test/anchor' }) : undefined,
      guard,
      debug: cfg.debug,
    })
  }
  if (name === 'webbridge_status') return daemon.status()
  if (name === 'close_session') {
    const res = await daemon.callWithAutostart('close_session', args, session)
    if (res.ok) {
      store.forget(session)
      guard.forget(session)
    }
    return res
  }
  return null
}

/**
 * Legacy passthrough tools still change which tab the session works on, so the
 * guard is updated here: a successful navigate/find_tab binds the session, and
 * closing the working tab leaves it unknown.
 */
function noteTabBinding(name, args, session, value) {
  if (name === 'find_tab' && value?.success !== false) {
    guard.bind(session, { url: value?.url ?? args.url, source: 'find_tab', borrowed: value?.borrowed === true })
    if (value?.borrowed === true) guard.markAnchor(session, value?.tabId)
  } else if (name === 'navigate' && value?.success !== false) {
    guard.bind(session, { url: value?.url ?? args.url, source: 'navigate' })
  } else if (name === 'close_tab' && value?.closed === true) {
    guard.unbind(session, { reason: 'the working tab was closed', source: 'close_tab' })
  }
}

async function callTool(name, args, session) {
  const native = await callNative(name, args, session)
  if (native !== null) return native
  const res = await daemon.callWithAutostart(name, args, session)
  if (!res.ok) {
    const error = new Error(`webbridge ${res.error?.code ?? 'error'}: ${res.error?.message ?? 'unknown'}`)
    if (res.timedOut) {
      error.timedOut = true
      error.message = `${name} timed out after ${res.budgetMs} ms — ` +
        (name === 'navigate'
          ? 'navigate waits on the extension\u2019s load callback and can hang for minutes; use open_tab instead (it reuses or navigates a tab you already own, or borrows the tab in front). '
          : 'the effect is UNKNOWN: re-read page state (obs/find_tab) before retrying. ')
    }
    throw error
  }
  noteTabBinding(name, args, session, res.data)
  return res.data
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
      serverInfo: { name: 'kimi-webbridge-mcp', version: '1.1.0' },
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
      const value = await callTool(name, toolArgs, session)
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

process.stderr.write(`[webbridge-mcp] ready v1.1.0 (daemon: ${cfg.daemonUrl}${cfg.mock ? ' [MOCK]' : ''}, session default: ${cfg.defaultSession})\n`)

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
