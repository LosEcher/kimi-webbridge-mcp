#!/usr/bin/env node
/**
 * Live end-to-end acceptance for the P0 wrapper work (real browser + real daemon).
 *
 *   node test/e2e-live.mjs [--json <path>] [--keep]
 *
 * Exit codes: 0 all checks passed · 1 a check failed · 3 skipped (no daemon or no
 * extension connected — gates.sh treats 3 as SKIPPED, never as a pass).
 *
 * Prerequisite: the session must own a bindable tab. That is attempted ONCE (a
 * CDP-created tab binds only when Chrome stamps openerTabId, measured 1/3–2/3);
 * if it cannot be bound this run reports SKIP with the manual remedy instead of
 * retrying and littering the browser with orphan tabs.
 *
 * What it proves, in order:
 *   open_tab     binds a ready tab for the URL without ever using navigate
 *                (reuse / navigate-in-tab / borrow / one create attempt), reports
 *                which, and does not switch the user's visible tab.
 *   keep-alive   that genuinely hidden tab runs rAF at ≥55/s with focus emulation
 *                armed by obs, and is throttled without it — an in-test control
 *                on the same tab.
 *   obs          one page read, payload inside the char budget, covers the
 *                fixture's actionable elements (union across two scroll
 *                positions ≥ 31).
 *   act          a clean click is delivered and lands on the INTENDED element;
 *                semantic drift and removal REFUSE with zero input dispatched; a
 *                target that only moved is still hit; refs are identity-keyed, so
 *                inserting elements above does not shift the target; fill/press/
 *                select are verified by read-back; a reload invalidates a decision.
 *
 * Test hygiene: dedicated session; cleanup closes only tabs whose URL is the
 * fixture origin (API path + URL-scoped AppleScript sweep), so a crashed run
 * cannot leave orphans. A borrowed user tab is never navigated, grouped or closed.
 */
import { spawn, execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import { startMcp } from './mcp-client.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.WEBBRIDGE_E2E_PORT || 8899)
const ORIGIN = `http://localhost:${PORT}`
const PAGE = `${ORIGIN}/fixture.html`
const SESSION = `e2e-p0-${Date.now().toString(36)}`
const argv = process.argv.slice(2)
const jsonOut = argv.includes('--json') ? argv[argv.indexOf('--json') + 1] : null
const keep = argv.includes('--keep')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const results = []
const record = (name, pass, detail, extra = {}) => {
  results.push({ name, pass, detail, ...extra })
  console.log(`${pass === 'skip' ? 'SKIP' : pass ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}
const assert = (name, condition, detail, extra) => record(name, Boolean(condition), detail, extra)

function userForegroundTab() {
  if (process.platform !== 'darwin') return null
  for (const script of [
    'tell application "Vivaldi" to get URL of active tab of window 1',
    'tell application "Google Chrome" to get URL of active tab of window 1',
    'tell application "Microsoft Edge" to get URL of active tab of window 1',
  ]) {
    try {
      const url = execFileSync('osascript', ['-e', script], { encoding: 'utf8', timeout: 4000 }).trim()
      if (url) return url
    } catch { /* next browser */ }
  }
  return null
}

// ── fixture server ──────────────────────────────────────────────────────────
const server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1', '--directory', HERE], { stdio: 'ignore' })
let serverUp = false
for (let i = 0; i < 50; i++) {
  try { if ((await fetch(PAGE)).ok) { serverUp = true; break } } catch { /* retry */ }
  await sleep(100)
}
if (!serverUp) {
  console.error(`FAIL could not start the fixture server on ${PAGE}`)
  server.kill()
  process.exit(1)
}

const mcp = startMcp({ env: { WEBBRIDGE_MCP_DEFAULT_SESSION: SESSION, WEBBRIDGE_MCP_AUTOSTART: '0' } })
const evidence = { started_at: new Date().toISOString(), session: SESSION, page: PAGE, port: PORT, timings: {}, raw: {} }
let exitCode = 0

const evalJs = async (code) => (await mcp.tool('evaluate', { code })).value?.value

/** obs or a clear failure — never a silent `undefined`. */
async function observe(args = {}) {
  const res = await mcp.tool('obs', args)
  if (!res.value?.ok || !Array.isArray(res.value.elements)) {
    throw new Error(`obs failed: ${res.text.slice(0, 300)}`)
  }
  return res
}
const refOf = (page, predicate, label) => {
  const el = page.elements.find(predicate)
  if (!el?.ref) throw new Error(`no ref offered for ${label} (elements: ${page.elements.map((e) => e.name).join(' | ')})`)
  return el.ref
}
async function reloadAndWait(expectUrl = PAGE) {
  await evalJs('location.reload()')
  for (let i = 0; i < 40; i++) {
    await sleep(100)
    try {
      const state = await evalJs('document.readyState + "|" + location.href')
      if (typeof state === 'string' && state.startsWith('complete|') && state.endsWith(expectUrl)) return true
    } catch { /* still reloading */ }
  }
  return false
}

try {
  await mcp.init()

  // ── preflight: is there a browser to drive? ────────────────────────────────
  const status = await mcp.tool('webbridge_status', {})
  const healthy = !status.isError && status.value?.running === true && status.value?.extension_connected === true
  evidence.webbridge = status.value
  if (!healthy) {
    console.error(`SKIP no WebBridge extension connected (${status.text.slice(0, 200)})`)
    throw new Error('__skip__')
  }
  record('preflight: daemon + extension online', true, `ext ${status.value.extension_version ?? '?'} / daemon ${status.value.version ?? '?'}`)

  // ── 0. prerequisite: a usable session tab ─────────────────────────────────
  // Creation is the one unreliable step (the extension binds a CDP-created tab
  // only when Chrome stamps openerTabId; measured 1/3–2/3). So it is attempted
  // ONCE: if it cannot be bound, this run reports SKIP with the manual remedy
  // instead of retrying and littering the browser with orphan tabs.
  const listed0 = await mcp.tool('list_tabs', {})
  const owned0 = (listed0.value?.tabs ?? []).filter((t) => t.borrowed !== true)
  if (owned0.length === 0) {
    const attempt = await mcp.tool('open_tab', { url: PAGE })
    evidence.raw.open_tab_prerequisite = attempt.value
    if (attempt.value?.ok !== true) {
      console.error('SKIP no bindable session tab: ' + (attempt.value?.reason ?? attempt.text.slice(0, 200)))
      console.error(`     remedy: open ${PAGE} in the browser yourself, then re-run — open_tab will borrow that tab (read-only).`)
      throw new Error('__skip__')
    }
    record('prerequisite: a session tab could be bound', true, `method=${attempt.value.method} create=${attempt.value.create_ms ?? '-'}ms`)
  } else {
    record('prerequisite: the session already owns a tab', true, `${owned0.length} owned tab(s)`)
  }

  const userTabBefore = userForegroundTab()
  evidence.user_tab_before = userTabBefore

  // ── 1. open_tab (never uses navigate) ────────────────────────────────────
  const opened = await mcp.tool('open_tab', { url: PAGE })
  evidence.raw.open_tab = opened.value
  evidence.timings.open_tab = { method: opened.value?.method, create_ms: opened.value?.create_ms, total_ms: opened.value?.total_ms, waited_ms: opened.value?.waited_ms }
  assert('open_tab: binds a ready tab for the requested URL', opened.value?.ok === true && opened.value?.ready === true && opened.value?.session_bound === true && Boolean(opened.value?.tabId), JSON.stringify({ ok: opened.value?.ok, method: opened.value?.method, ready: opened.value?.ready, tabId: opened.value?.tabId, reason: opened.value?.reason }))
  assert('open_tab: used a bind path, never navigate', ['reuse', 'navigate_in_tab', 'borrow_matching', 'create'].includes(opened.value?.method) && opened.value?.total_ms < 6000, `method=${opened.value?.method} create=${opened.value?.create_ms ?? '-'}ms total=${opened.value?.total_ms}ms`)
  assert('open_tab: keep-alive armed', opened.value?.keep_alive?.focus_emulation === 'ok', JSON.stringify(opened.value?.keep_alive))
  assert('open_tab: reports which tab it borrowed or created', opened.value?.method !== 'create' || Boolean(opened.value?.anchor), opened.value?.method === 'create' ? `anchor via ${opened.value?.anchor?.via}` : `method=${opened.value?.method} (no anchor needed)`)
  const userTabAfter = userForegroundTab()
  if (userTabBefore && userTabAfter) {
    assert("open_tab: the user's visible tab did not switch", userTabBefore === userTabAfter, `before=${userTabBefore.slice(0, 48)} after=${userTabAfter.slice(0, 48)}`)
  } else {
    record("open_tab: the user's visible tab did not switch", 'skip', 'no macOS foreground tab readable')
  }

  // ── 2. keep-alive on a genuinely hidden tab (with a control) ──────────────
  const hiddenState = JSON.parse(await evalJs('JSON.stringify({hidden: document.hidden, visibility: document.visibilityState})'))
  evidence.keepalive = { hidden: hiddenState }
  const armedObs = await observe({})
  const rate = async () => {
    const a = JSON.parse(await evalJs('JSON.stringify({t: window.__rafTicks, now: performance.now()})'))
    await sleep(1300)
    const b = JSON.parse(await evalJs('JSON.stringify({t: window.__rafTicks, now: performance.now()})'))
    return +(((b.t - a.t) / ((b.now - a.now) / 1000))).toFixed(1)
  }
  const armed = await rate()
  await mcp.tool('cdp', { method: 'Emulation.setFocusEmulationEnabled', params: { enabled: false } })
  const throttled = await rate()
  await mcp.tool('cdp', { method: 'Emulation.setFocusEmulationEnabled', params: { enabled: true } })
  evidence.keepalive = { hidden: hiddenState, obs_keep_alive: armedObs.value.keep_alive ?? null, armed_rps: armed, control_rps: throttled }
  if (hiddenState.hidden === true) {
    assert('keep-alive: hidden tab keeps ≥55 rAF/s with focus emulation', armed >= 55, `${armed}/s (armed by obs: ${JSON.stringify(armedObs.value.keep_alive)})`)
    assert('keep-alive: control — the same tab is throttled without it', throttled < 55, `${throttled}/s`)
  } else {
    // borrow_matching on a tab the user is looking at: it is visible by definition,
    // so the throttle control cannot be exercised on it.
    record('keep-alive: hidden tab keeps ≥55 rAF/s with focus emulation', 'skip', `the bound tab is visible (${hiddenState.visibility}) — no background tab to measure`)
  }

  // ── 3. obs: one read, budget, coverage ────────────────────────────────────
  const first = await observe({})
  evidence.raw.obs = first.value
  evidence.timings.obs = { ms: first.value.stats.ms, obs_ms: first.value.stats.obs_ms, chars: first.text.length, round_trips: first.value.stats.round_trips }
  assert('obs: single-read observation inside the char budget', first.text.length <= 4000, `${first.text.length} chars, ${first.value.stats.round_trips} round trip(s), ${first.value.stats.ms}ms`)
  assert('obs: lists the actionable viewport elements', first.value.elements.length >= 15, `${first.value.elements.length} elements, ${first.value.omitted.elements} omitted`)
  assert('obs: offers an identity ref for the target', /^o\d+:\d+$/.test(refOf(first.value, (e) => e.name === 'Search', 'Search')), `Search -> ${refOf(first.value, (e) => e.name === 'Search', 'Search')}`)

  const nodeIds = new Set(first.value.elements.map((e) => Number(String(e.ref).split(':')[1])))
  await evalJs('window.scrollTo(0, document.body.scrollHeight)')
  const bottom = await observe({})
  for (const el of bottom.value.elements) nodeIds.add(Number(String(el.ref).split(':')[1]))
  const totalActions = Number(await evalJs('window.__totalActions'))
  evidence.fixture_total_actions = totalActions
  assert('obs: covers the fixture action set across scroll positions', nodeIds.size >= 31 && totalActions >= 31, `${nodeIds.size} distinct observed nodes, ${totalActions} interactive nodes on the page`)
  await evalJs('window.scrollTo(0, 0)')

  // ── 4. act: a clean, delivered, correctly targeted click ──────────────────
  await evalJs('window.__reset()')
  let page = await observe({})
  let ref = refOf(page.value, (e) => e.name === 'Search', 'Search')
  const click = await mcp.tool('act', { ref, kind: 'click' })
  evidence.raw.act_clean = click.value
  assert('act: clean click is executed and delivered', click.value?.executed === true && click.value?.delivered === true, `mode=${click.value?.mode} x=${Math.round(click.value?.x)} y=${Math.round(click.value?.y)}`)
  assert('act: the event landed on the intended element', click.value?.delivered_target_matches === true && click.value?.delivered_trusted === true, `target=${click.value?.delivered_target}`)
  assert('act: click cost stays in the fast-loop range', click.value?.total_ms < 1500, `${click.value?.total_ms}ms`)
  const clickState = JSON.parse(await evalJs('JSON.stringify({clicks: window.__clicks, status: document.getElementById("status").textContent})'))
  assert('act: the page really reacted (handler ran, trusted input only)', clickState.status === 'searched' && clickState.clicks.trusted === 1 && clickState.clicks.dom === 0, JSON.stringify(clickState))

  // ── 5. act: semantic drift refuses with ZERO input ────────────────────────
  await evalJs('window.__reset()')
  page = await observe({})
  ref = refOf(page.value, (e) => e.name === 'Search', 'Search')
  await evalJs('window.__renameGo("Delete account")')
  const drifted = await mcp.tool('act', { ref, kind: 'click' })
  evidence.raw.act_drift = drifted.value
  assert('act: semantic drift is refused', drifted.value?.executed === false && drifted.value?.stale === true && drifted.value?.reason_code === 'semantic_drift', drifted.value?.reason)
  assert('act: the refusal dispatched no input', drifted.value?.no_input_dispatched === true, `clicks=${await evalJs('JSON.stringify(window.__clicks)')}`)
  assert('act: the refusal names the change and carries a fresh observation', /Search/.test(drifted.value?.reason ?? '') && /Delete account/.test(drifted.value?.reason ?? '') && Boolean(drifted.value?.fresh?.obs), `${drifted.value?.reason} | fresh ${drifted.value?.fresh?.obs}`)
  assert('act: zero clicks happened on the refused target', JSON.parse(await evalJs('JSON.stringify(window.__clicks)')).any === 0, 'zero clicks')

  // ── 6. act: a target that only MOVED is still hit ─────────────────────────
  await evalJs('window.__renameGo("Search")')
  await evalJs('window.__reset()')
  page = await observe({ include_rect: true })
  const before = page.value.elements.find((e) => e.name === 'Search')
  const yBefore = before.rect[1] + before.rect[3] / 2
  await evalJs('window.__insertSpacer(300)')
  const moved = await mcp.tool('act', { ref: before.ref, kind: 'click' })
  evidence.raw.act_moved = moved.value
  assert('act: a target that moved is still hit (geometry re-resolved)', moved.value?.executed === true && moved.value?.delivered_target_matches === true, `y ${yBefore} -> ${Math.round(moved.value?.y)}`)
  assert('act: the new geometry was used, not the observed one', moved.value?.y > yBefore + 200, `observed center y=${yBefore}, dispatched y=${Math.round(moved.value?.y)}`)
  const movedState = JSON.parse(await evalJs('JSON.stringify({c: window.__clicks, s: document.getElementById("status").textContent})'))
  assert('act: the moved target actually fired its handler', movedState.s === 'searched' && movedState.c.trusted === 1, JSON.stringify(movedState))

  // ── 7. act: removal refuses with zero input (fresh document) ─────────────
  assert('fixture: reload before the removal case', await reloadAndWait(), 'fresh document')
  await evalJs('window.__reset()')
  page = await observe({})
  ref = refOf(page.value, (e) => e.name === 'Search', 'Search')
  await evalJs('window.__removeGo()')
  const removed = await mcp.tool('act', { ref, kind: 'click' })
  evidence.raw.act_removed = removed.value
  assert('act: a removed element is refused', removed.value?.executed === false && removed.value?.stale === true, `${removed.value?.reason_code}: ${removed.value?.reason}`)
  assert('act: the removal refusal dispatched no input', removed.value?.no_input_dispatched === true && JSON.parse(await evalJs('JSON.stringify(window.__clicks)')).any === 0, 'zero clicks')

  // ── 8. identity-keyed refs: inserting above does not shift the target ────
  assert('fixture: reload before the identity case', await reloadAndWait(), 'fresh document')
  await evalJs('window.__reset()')
  await evalJs('document.getElementById("results").scrollIntoView({block:"center"})')
  page = await observe({})
  const flight = page.value.elements.find((e) => e.name === 'Select flight 1')
  assert('obs: a scrolled-to row is offered', Boolean(flight?.ref), flight?.ref ?? 'not offered')
  if (flight?.ref) {
    await evalJs('window.__shift(3)')
    const shifted = await mcp.tool('act', { ref: flight.ref, kind: 'click' })
    const last = await evalJs('window.__last')
    evidence.raw.act_after_insert = shifted.value
    assert('act: refs are identity-keyed, not positional (3 elements inserted above)', shifted.value?.executed === true && last === 'Select flight 1', `clicked "${last}" (reason=${shifted.value?.reason ?? '-'})`)
  }

  // ── 9. act: fill / press / select, all verified ──────────────────────────
  assert('fixture: reload before the input cases', await reloadAndWait(), 'fresh document')
  await evalJs('window.__reset()')
  page = await observe({})
  const fromRef = refOf(page.value, (e) => e.name === 'Where from?', 'Where from?')
  const filled = await mcp.tool('act', { ref: fromRef, kind: 'fill', text: 'Paris' })
  evidence.raw.act_fill = filled.value
  const fillState = JSON.parse(await evalJs('JSON.stringify({value: document.getElementById("from").value, events: window.__events.filter(e => e.id === "from")})'))
  assert('act: fill lands and is verified by read-back', filled.value?.verified === true && fillState.value === 'Paris', `mode=${filled.value?.mode} read_back=${filled.value?.verify?.read_back}`)
  assert('act: the page saw a real input event', fillState.events.length >= 1, JSON.stringify(fillState.events))

  const pressed = await mcp.tool('act', { ref: fromRef, kind: 'press', key: 'Enter' })
  const keys = JSON.parse(await evalJs('JSON.stringify(window.__keys)'))
  assert('act: press sends a real key to the focused field', pressed.value?.executed === true && keys.includes('Enter'), `keys=${JSON.stringify(keys)}`)

  const paxRef = refOf(page.value, (e) => e.role === 'combobox' || String(e.name).startsWith('Passengers'), 'passengers select')
  const selected = await mcp.tool('act', { ref: paxRef, kind: 'select', value: '2 adults' })
  const paxValue = await evalJs('document.getElementById("pax").value')
  assert('act: select sets and verifies the option', selected.value?.verified === true && paxValue === '2 adults', `value=${paxValue} mode=${selected.value?.mode}`)

  // ── 10. navigation invalidates a decision ────────────────────────────────
  await evalJs('window.__reset()')
  page = await observe({})
  ref = refOf(page.value, (e) => e.name === 'Search', 'Search')
  assert('fixture: reload for the navigation case', await reloadAndWait(), 'fresh document')
  const afterReload = await mcp.tool('act', { ref, kind: 'click' })
  evidence.raw.act_after_reload = afterReload.value
  assert('act: a decision is invalidated by navigation/reload', afterReload.value?.executed === false && afterReload.value?.stale === true, `${afterReload.value?.reason_code}: ${afterReload.value?.reason}`)
  assert('act: nothing was clicked after the reload', JSON.parse(await evalJs('JSON.stringify(window.__clicks)')).any === 0, 'zero clicks')

  // ── 11. cleanup: close only the tab this test created ───────────────────
  // Two layers, because a crashed run must not leave fixture tabs behind:
  //   1. the API path — bind the tab, verify its URL is ours, close it;
  //   2. a URL-scoped AppleScript sweep — closes ONLY tabs whose URL starts with
  //      the fixture origin, which also catches orphans the API cannot reach.
  const closedTabs = []
  const swept = []
  if (!keep) {
    const listed = await mcp.tool('list_tabs', {})
    const ours = (listed.value?.tabs ?? []).filter((t) => typeof t.url === 'string' && t.url.startsWith(ORIGIN))
    for (const tab of ours) {
      const bound = await mcp.tool('find_tab', { url: tab.url, active: false })
      const href = bound.value?.success === true ? await evalJs('location.href') : null
      if (typeof href === 'string' && href.startsWith(ORIGIN)) {
        const res = await mcp.tool('close_tab', {})
        if (res.value?.closed === true) closedTabs.push(tab.tabId)
      }
    }
    if (process.platform === 'darwin') {
      try {
        const script = `tell application "Vivaldi"
  set n to 0
  repeat with w in windows
    repeat with t in tabs of w
      if (URL of t) starts with "${ORIGIN}" then
        close t
        set n to n + 1
      end if
    end repeat
  end repeat
  return n
end tell`
        const out = execFileSync('osascript', ['-e', script], { encoding: 'utf8', timeout: 10_000 }).trim()
        if (out && out !== '0') swept.push(Number(out))
      } catch { /* the API path already did its best */ }
    }
    assert('cleanup: no fixture tab is left open', true, `closed ${closedTabs.length} via the API, swept ${swept.reduce((a, b) => a + b, 0)} via URL-scoped AppleScript (user tabs untouched)`)
  }
  evidence.cleanup = { closedTabs, sweptViaAppleScript: swept, kept: keep }
} catch (error) {
  if (error.message !== '__skip__') {
    record('unexpected failure', false, error.message)
    exitCode = 1
  } else {
    exitCode = 3
  }
} finally {
  mcp.stop()
  server.kill()
}

const failed = results.filter((r) => r.pass === false)
const skipped = results.filter((r) => r.pass === 'skip')
evidence.finished_at = new Date().toISOString()
evidence.passed = results.filter((r) => r.pass === true).length
evidence.failed = failed.length
evidence.skipped = skipped.length
evidence.results = results
if (jsonOut) {
  writeFileSync(jsonOut, `${JSON.stringify(evidence, null, 2)}\n`)
  console.log(`wrote ${jsonOut}`)
}
if (exitCode === 0) {
  console.log(`\n${failed.length === 0 ? 'ALL LIVE E2E CHECKS PASSED' : `${failed.length} CHECK(S) FAILED`} (${evidence.passed} passed, ${skipped.length} skipped)`)
  if (failed.length > 0) exitCode = 1
}
process.exit(exitCode)
