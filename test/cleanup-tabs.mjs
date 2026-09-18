#!/usr/bin/env node
/**
 * Close fixture tabs left behind by crashed/interrupted test runs.
 *
 *   node test/cleanup-tabs.mjs [--origin http://localhost:8899] [--sessions a,b,c]
 *
 * Safety: a tab is closed ONLY when the working tab's own `location.href` is
 * verified to start with the fixture origin. A borrowed user tab is never
 * closed, whatever its session bookkeeping says.
 */
const DAEMON = process.env.WEBBRIDGE_DAEMON_URL || 'http://127.0.0.1:10086'
const argv = process.argv.slice(2)
const argOf = (flag, fallback) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : fallback)
const ORIGIN = argOf('--origin', 'http://localhost:8899')
const SESSIONS = argOf('--sessions', 'e2e-p0,e2e,webbridge-mcp-e2e').split(',').map((s) => s.trim()).filter(Boolean)

async function call(action, args, session) {
  const res = await fetch(`${DAEMON}/command`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, args, session }),
  })
  const body = await res.json().catch(() => null)
  return { ok: body?.ok !== false, data: body?.data, error: body?.error?.message }
}

const closed = []
const skipped = []
for (const session of SESSIONS) {
  for (let guard = 0; guard < 8; guard++) {
    const listed = await call('list_tabs', {}, session)
    const tabs = listed.data?.tabs ?? []
    const ours = tabs.filter((t) => typeof t.url === 'string' && t.url.startsWith(ORIGIN))
    if (ours.length === 0) break
    const bound = await call('find_tab', { url: ours[0].url, active: false }, session)
    if (!bound.data?.success) { skipped.push({ session, url: ours[0].url, why: `find_tab: ${bound.error}` }); break }
    const href = (await call('evaluate', { code: 'location.href' }, session)).data?.value
    if (typeof href !== 'string' || !href.startsWith(ORIGIN)) {
      skipped.push({ session, url: ours[0].url, why: `working tab is ${href} — refusing to close` })
      break
    }
    const res = await call('close_tab', {}, session)
    if (res.data?.closed === true) closed.push({ session, tabId: ours[0].tabId, url: href })
    else { skipped.push({ session, url: ours[0].url, why: `close_tab: ${JSON.stringify(res.data ?? res.error)}` }); break }
  }
  const remaining = (await call('list_tabs', {}, session)).data?.tabs ?? []
  console.log(`${session}: ${remaining.length} tab(s) left${remaining.length ? ` — ${remaining.map((t) => t.url).join(', ').slice(0, 160)}` : ''}`)
}
console.log(JSON.stringify({ closed, skipped }, null, 2))
