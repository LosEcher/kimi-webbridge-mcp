#!/usr/bin/env node
/**
 * MCP client smoke test for kimi-webbridge-mcp.
 *
 * Spawns server.mjs over stdio and walks the real MCP handshake:
 *   initialize -> notifications/initialized -> tools/list -> tools/call
 *
 * Usage:
 *   node test/test-client.mjs --mock          # canned results, no daemon (CI-safe)
 *   node test/test-client.mjs                 # real daemon; webbridge_status + list_tabs
 *   node test/test-client.mjs --tool fill --args '{"selector":"@e1","value":"hi"}'
 *
 * Exit code 0 on success, 1 on any failure. Prints one line per response.
 */

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const mock = args.includes('--mock')
const extraToolArg = args.indexOf('--tool')
const env = { ...process.env }
if (mock) env.WEBBRIDGE_MCP_MOCK = '1'

const child = spawn(process.execPath, [join(root, 'server.mjs')], {
  stdio: ['pipe', 'pipe', 'inherit'],
  env,
})

let buf = ''
const pending = new Map()
let nextId = 0

child.stdout.setEncoding('utf8')
child.stdout.on('data', (chunk) => {
  buf += chunk
  let nl
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim()
    buf = buf.slice(nl + 1)
    if (!line) continue
    let msg
    try { msg = JSON.parse(line) } catch { continue }
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve } = pending.get(msg.id)
      pending.delete(msg.id)
      resolve(msg)
    }
  }
})

function rpc(method, params) {
  const id = ++nextId
  return new Promise((resolve) => {
    pending.set(id, { resolve })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
}

function assert(cond, label, detail) {
  if (!cond) {
    console.error(`FAIL ${label}${detail ? `: ${detail}` : ''}`)
    process.exitCode = 1
    throw new Error(`assertion failed: ${label}`)
  }
  console.log(`PASS ${label}`)
}

function toolResultText(msg) {
  const content = msg.result?.content ?? []
  const text = content.map((c) => c.text ?? '').join('\n')
  return { text, isError: Boolean(msg.result?.isError) }
}

try {
  // 1. initialize
  const init = await rpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'webbridge-mcp-test', version: '0.0.1' },
  })
  assert(init.result?.protocolVersion === '2024-11-05', 'initialize', JSON.stringify(init))
  assert(init.result?.serverInfo?.name === 'kimi-webbridge-mcp', 'serverInfo.name')

  // 2. initialized notification (server must not reply; we just move on)
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n')

  // 3. ping
  const pong = await rpc('ping', {})
  assert(pong.result !== undefined, 'ping')

  // 4. tools/list
  const list = await rpc('tools/list', {})
  const tools = list.result?.tools ?? []
  const names = tools.map((t) => t.name)
  for (const expected of ['navigate', 'find_tab', 'snapshot', 'click', 'fill', 'evaluate', 'cdp',
    'screenshot', 'network', 'upload', 'save_as_pdf', 'list_tabs', 'close_tab', 'close_session',
    'webbridge_status']) {
    assert(names.includes(expected), `tool present: ${expected}`)
  }
  for (const t of tools) {
    assert(t.inputSchema?.type === 'object', `schema object: ${t.name}`)
  }

  // 5. webbridge_status
  const status = await rpc('tools/call', { name: 'webbridge_status', arguments: {} })
  const statusText = toolResultText(status)
  console.log(`INFO webbridge_status -> ${statusText.text.slice(0, 200)}`)
  assert(!statusText.isError, 'webbridge_status succeeds', statusText.text.slice(0, 300))

  // 6. read-only call against the current session (mock: canned; real: may fail
  //    with "no extension connected" — that is the expected real-world error path)
  const tabs = await rpc('tools/call', { name: 'list_tabs', arguments: { session: 'webbridge-mcp-smoke' } })
  const tabsText = toolResultText(tabs)
  console.log(`INFO list_tabs -> ${tabsText.text.slice(0, 200)}`)
  if (mock) {
    assert(!tabsText.isError, 'list_tabs succeeds (mock)')
  } else if (tabsText.isError) {
    assert(/no extension connected/.test(tabsText.text), 'list_tabs error path (no extension)', tabsText.text.slice(0, 300))
  }

  // 7. optional extra tool call
  if (extraToolArg >= 0) {
    const toolName = args[extraToolArg + 1]
    const toolArgs = JSON.parse(args[extraToolArg + 2] ?? '{}')
    const res = await rpc('tools/call', { name: toolName, arguments: toolArgs })
    const r = toolResultText(res)
    console.log(`INFO extra ${toolName} -> ${r.text.slice(0, 300)}${r.isError ? ' [isError]' : ''}`)
  }

  console.log(mock ? 'ALL MOCK TESTS PASSED' : 'ALL REAL-MODE TESTS PASSED')
} catch (error) {
  console.error(`FAILED: ${error.message}`)
  process.exitCode = 1
} finally {
  child.kill()
}
