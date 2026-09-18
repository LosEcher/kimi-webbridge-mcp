/**
 * Minimal MCP stdio client used by the tests: spawn a server, speak JSON-RPC,
 * call tools. Keeps the live E2E readable.
 */
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

export function startMcp({ env = {}, serverPath = join(root, 'server.mjs') } = {}) {
  const child = spawn(process.execPath, [serverPath], {
    stdio: ['pipe', 'pipe', 'inherit'],
    env: { ...process.env, ...env },
  })
  let buffer = ''
  const pending = new Map()
  let nextId = 0

  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    buffer += chunk
    let nl
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim()
      buffer = buffer.slice(nl + 1)
      if (!line) continue
      let message
      try { message = JSON.parse(line) } catch { continue }
      if (message.id !== undefined && pending.has(message.id)) {
        const { resolve } = pending.get(message.id)
        pending.delete(message.id)
        resolve(message)
      }
    }
  })

  const rpc = (method, params) => {
    const id = ++nextId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`MCP ${method} timed out after 60s`))
      }, 60_000)
      pending.set(id, { resolve: (msg) => { clearTimeout(timer); resolve(msg) } })
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  }

  return {
    rpc,
    child,
    async init() {
      const init = await rpc('initialize', {
        protocolVersion: '2024-11-05', capabilities: {},
        clientInfo: { name: 'webbridge-e2e', version: '1.0.0' },
      })
      if (init.result?.protocolVersion !== '2024-11-05') throw new Error(`bad initialize: ${JSON.stringify(init)}`)
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`)
      return init.result
    },
    /** Call a tool and return { value, text, isError } (value = parsed JSON text). */
    async tool(name, args = {}) {
      const res = await rpc('tools/call', { name, arguments: args })
      const text = (res.result?.content ?? []).map((c) => c.text ?? '').join('\n')
      let value = null
      try { value = JSON.parse(text) } catch { /* not JSON (error text) */ }
      return { value, text, isError: Boolean(res.result?.isError) }
    },
    stop() {
      child.kill()
    },
  }
}
