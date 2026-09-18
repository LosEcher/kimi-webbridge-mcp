/**
 * Unit tests — no browser, no daemon (node --test).
 *
 * Covers the pure logic (refs, guard freshness, payload budget, readiness,
 * budgets) and the obs/act/open_tab handlers against the in-process fake daemon,
 * including the refusals that P0 exists for: semantic drift and removal must
 * dispatch ZERO input.
 *
 * Run: node --test test/
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'

import {
  createObsStore, guardDiff, summarizeDiff, pageKeyChanged, describePageKeyChange,
  mintRef, parseRef, isRef, GUARD_FIELDS,
} from '../lib/refs.mjs'
import { buildObsPayload, DEFAULT_LIMITS } from '../lib/payload.mjs'
import { urlMatches, urlIdentity, readyStateOk, pollUntil, parseUrl } from '../lib/readiness.mjs'
import { resolveBudget, parseErrorBody, createDaemonClient, ACTION_BUDGETS } from '../lib/daemon.mjs'
import { createObsHandler } from '../lib/obs.mjs'
import { createActHandler, KEYS } from '../lib/act.mjs'
import { openTab } from '../lib/tabs.mjs'
import { createMockCall } from '../lib/mock-daemon.mjs'
import { createSessionGuard } from '../lib/sessions.mjs'

// ── helpers ─────────────────────────────────────────────────────────────────

const guard = (over = {}) => ({
  node: 7, role: 'button', name: 'Search', value: null, checked: null, selectedIndex: null,
  readOnly: null, disabled: false, ariaDisabled: null, ariaExpanded: null, ariaChecked: null,
  ariaSelected: null, href: null, scope: 'Search form', ...over,
})

function harness({ mock = createMockCall(), cfg: overrides = {}, withGuard = false } = {}) {
  const cfg = {
    debug: false, mock: true, timeoutMs: 5000,
    obsTimeoutMs: 5000, actCheckTimeoutMs: 5000, actInputTimeoutMs: 5000,
    obsMaxChars: DEFAULT_LIMITS.maxChars, obsMaxElements: DEFAULT_LIMITS.maxElements,
    obsTextChars: DEFAULT_LIMITS.textChars,
    ...overrides,
  }
  const daemon = createDaemonClient({ daemonUrl: 'http://127.0.0.1:1', daemonBin: '/bin/false', autostart: false, mock: true, mockCall: mock })
  const store = createObsStore()
  const guard = createSessionGuard()
  const calls = []
  const call = (action, args, session, opts) => {
    calls.push({ action, args })
    return daemon.call(action, args, session, opts)
  }
  const obs = createObsHandler({ call, store, cfg, guard: withGuard ? guard : null })
  const act = createActHandler({ call, store, cfg, obs, guard: withGuard ? guard : null })
  return { cfg, daemon, store, guard, calls, call, obs, act, session: 'unit' }
}

const findRef = (payload, name) => {
  const el = payload.elements.find((e) => e.name === name)
  assert.ok(el, `element ${name} present (have: ${payload.elements.map((e) => e.name).join(', ')})`)
  return el.ref
}
const state = async (daemon, session) => JSON.parse((await daemon.call('evaluate', { code: 'mock:state' }, session)).data.value)

// ── refs ────────────────────────────────────────────────────────────────────

test('refs: mint/parse round trip and malformed rejection', () => {
  assert.equal(mintRef(3, 17), 'o3:17')
  assert.deepEqual(parseRef('o3:17'), { generation: 3, node: 17 })
  assert.deepEqual(parseRef(' o12:4 '), { generation: 12, node: 4 })
  for (const bad of ['', 'e1', '@e1', 'o3', 'o3:', ':4', 'o0:4', 'o-1:4', 'o3:0', null, 7, 'o1:2x']) {
    assert.equal(parseRef(bad), null, `rejects ${JSON.stringify(bad)}`)
    assert.equal(isRef(bad), false)
  }
  assert.throws(() => mintRef(0, 1))
  assert.throws(() => mintRef(1, 0))
})

test('refs: store mints refs per generation and keeps earlier ones resolvable', () => {
  const store = createObsStore()
  const { generation } = store.begin('s')
  store.commit('s', generation, [{ node: 5, kind: 'click', guard: guard() }])
  assert.equal(store.get('s', 'o1:5').entry.kind, 'click')
  const second = store.begin('s')
  store.commit('s', second.generation, [{ node: 9, kind: 'fill', guard: guard({ role: 'textbox' }) }])
  assert.equal(store.get('s', 'o2:9').entry.kind, 'fill')
  // an older ref is still resolvable (the guard, not the ref lifetime, protects)
  assert.equal(store.get('s', 'o1:5').entry.kind, 'click')
  assert.match(store.get('s', 'o1:77').error, /unknown or expired ref/)
  assert.match(store.get('s', 'nonsense').error, /malformed ref/)
  assert.match(createObsStore().get('empty', 'o1:1').error, /no observation in this session/)
})

test('refs: commit rejects a stale generation (no accidental cross-generation minting)', () => {
  const store = createObsStore()
  const { generation } = store.begin('s')
  store.begin('s')
  assert.throws(() => store.commit('s', generation, []), /is not the current/)
})

test('refs: store is bounded, oldest refs evicted first', () => {
  const store = createObsStore({ maxRefs: 3 })
  for (let i = 1; i <= 4; i++) {
    const { generation } = store.begin('s')
    store.commit('s', generation, [{ node: i, kind: 'click', guard: guard() }])
  }
  assert.equal(store.stats('s').refs, 3)
  assert.match(store.get('s', 'o1:1').error, /unknown or expired/)
  assert.ok(store.get('s', 'o4:4').entry)
})

// ── freshness ───────────────────────────────────────────────────────────────

test('guardDiff: name/value/state changes are reported with field names', () => {
  assert.deepEqual(guardDiff(guard(), guard()), [])
  const renamed = guardDiff(guard(), guard({ name: 'Delete account' }))
  assert.deepEqual(renamed, [{ field: 'name', from: 'Search', to: 'Delete account' }])
  assert.match(summarizeDiff(renamed), /semantic drift: name "Search" → "Delete account"/)

  const filled = guardDiff(guard({ role: 'textbox', value: '' }), guard({ role: 'textbox', value: 'Paris' }))
  assert.deepEqual(filled, [{ field: 'value', from: '', to: 'Paris' }])

  const disabled = guardDiff(guard(), guard({ disabled: true }))
  assert.deepEqual(disabled, [{ field: 'disabled', from: false, to: true }])
  assert.match(summarizeDiff(disabled), /disabled/)

  const scope = guardDiff(guard(), guard({ scope: 'x'.repeat(120) }))
  assert.deepEqual(scope, [{ field: 'scope', chars: { from: 11, to: 120 } }])
  assert.match(summarizeDiff(scope), /surrounding text changed \(11 → 120 chars\)/)

  const multi = guardDiff(guard(), guard({ name: 'Other', href: '#other' }))
  assert.equal(multi.length, 2)
  assert.match(summarizeDiff(multi), /\(\+1 more field: href\)/)
})

test('guardDiff: null and undefined are the same absence, not a change', () => {
  assert.deepEqual(guardDiff(guard({ href: null }), guard({ href: undefined })), [])
  assert.deepEqual(guardDiff(guard({ ariaDisabled: undefined }), guard({ ariaDisabled: null })), [])
  assert.deepEqual(GUARD_FIELDS.includes('scope'), true)
})

test('pageKey: navigation and viewport count, scroll does NOT', () => {
  const key = [1, 'https://a.test/', 1280, 800]
  assert.equal(pageKeyChanged(key, [1, 'https://a.test/', 1280, 800]), false)
  assert.equal(pageKeyChanged(key, [2, 'https://a.test/', 1280, 800]), true)
  assert.equal(pageKeyChanged(key, [1, 'https://a.test/b', 1280, 800]), true)
  assert.equal(pageKeyChanged(key, [1, 'https://a.test/', 1024, 800]), true)
  assert.equal(pageKeyChanged(null, key), false, 'missing keys are not a change')
  assert.match(describePageKeyChange(key, [2, 'https://a.test/', 1280, 800]), /reloaded or navigated/)
  assert.match(describePageKeyChange(key, [1, 'https://b.test/', 1280, 800]), /navigated/)
  assert.match(describePageKeyChange(key, [1, 'https://a.test/', 1024, 800]), /resized/)
})

// ── payload budget ──────────────────────────────────────────────────────────

const fakePage = (count, over = {}) => ({
  url: 'https://a.test/', title: 'A', w: 1280, h: 800,
  pageKey: [1, 'https://a.test/', 1280, 800],
  text: 'visible text '.repeat(300),
  textChars: 3900,
  scroll: { y: 0, height: 3000 },
  elements: Array.from({ length: count }, (_, i) => ({
    node: i + 1, role: 'button', name: `Button number ${i + 1}`, kind: 'click', rect: [0, 0, 10, 10],
  })),
  guards: Object.fromEntries(Array.from({ length: count }, (_, i) => [i + 1, guard({ node: i + 1 })])),
  omittedElements: 0,
  ...over,
})

test('payload: stays inside the character budget and reports what it dropped', () => {
  const built = buildObsPayload(fakePage(200), { generation: 1, maxChars: 4000, maxElements: 120, textChars: 1200 })
  assert.ok(built.stats.chars <= 4000, `chars ${built.stats.chars} <= 4000`)
  assert.ok(built.stats.elements_offered > 0)
  assert.ok(built.stats.elements_offered < 200, 'not everything fits')
  assert.equal(built.payload.omitted.elements, 200 - built.stats.elements_offered)
  assert.ok(built.payload.omitted.text_chars > 0, 'text truncation reported, not silent')
  assert.equal(built.payload.elements.length, built.stats.elements_offered)
})

test('payload: offered refs are exactly the elements the model can see', () => {
  const built = buildObsPayload(fakePage(10), { generation: 4, maxChars: 4000 })
  assert.deepEqual(built.offered.map((o) => o.ref), built.payload.elements.map((e) => e.ref))
  assert.equal(built.payload.obs, 'o4')
  assert.ok(built.payload.elements.every((e) => /^o4:\d+$/.test(e.ref)))
  assert.ok(built.offered.every((o) => o.guard && Array.isArray(o.pageKey)), 'execution records carry the guard + page key')
})

test('payload: an impossible budget is reported as truncated, never silently ignored', () => {
  const built = buildObsPayload(fakePage(5), { generation: 1, maxChars: 200 })
  assert.equal(built.stats.truncated, true)
  assert.equal(built.payload.truncated, true)
})

test('payload: maxElements caps the table and counts the remainder as omitted', () => {
  const built = buildObsPayload(fakePage(50), { generation: 1, maxElements: 5, maxChars: 100000 })
  assert.equal(built.payload.elements.length, 5)
  assert.equal(built.payload.omitted.elements, 45)
})

// ── readiness ───────────────────────────────────────────────────────────────

test('readiness: redirects, trailing slashes and prefixes are accepted; other paths are not', () => {
  assert.equal(urlMatches('https://a.test/x', 'https://a.test/x'), true)
  assert.equal(urlMatches('https://a.test/x/', 'https://a.test/x'), true)
  assert.equal(urlMatches('http://a.test/x', 'https://a.test/x'), false, 'http→https is a different origin')
  assert.equal(urlMatches('https://a.test/x?q=1#h', 'https://a.test/x'), true)
  assert.equal(urlMatches('https://a.test/x/y/z', 'https://a.test/x'), true, 'path prefix')
  assert.equal(urlMatches('https://a.test/xy', 'https://a.test/x'), false, 'prefix must be a path segment')
  assert.equal(urlMatches('https://m.a.test/x', 'https://a.test/x'), false)
  assert.equal(urlMatches('not a url', 'https://a.test/x'), false)
})

test('readiness: urlIdentity explains a mismatch and notices an SPA hash change', () => {
  assert.equal(urlIdentity('https://a.test/x', 'https://a.test/x').matches, true)
  const wrongHost = urlIdentity('https://127.0.0.1:3080/', 'http://127.0.0.1:8799/f.html', { mode: 'prefix' })
  assert.equal(wrongHost.matches, false)
  assert.match(wrongHost.reason, /different origin/)
  const wrongPath = urlIdentity('https://a.test/other', 'https://a.test/x')
  assert.match(wrongPath.reason, /different path/)
  const hash = urlIdentity('https://a.test/x#b', 'https://a.test/x#a')
  assert.equal(hash.matches, true)
  assert.equal(hash.hash_mismatch, true)
})

test('readiness: readyStateOk and pollUntil behave (success, budget, abort)', async () => {
  assert.equal(readyStateOk('complete'), true)
  assert.equal(readyStateOk('interactive'), true)
  assert.equal(readyStateOk('loading'), false)
  assert.equal(readyStateOk(undefined), false)

  let calls = 0
  const fast = await pollUntil(async () => (++calls >= 3 ? 'ok' : null), { timeoutMs: 1000, intervalMs: 5 })
  assert.deepEqual({ ok: fast.ok, value: fast.value, attempts: fast.attempts }, { ok: true, value: 'ok', attempts: 3 })

  const slow = await pollUntil(async () => null, { timeoutMs: 60, intervalMs: 10 })
  assert.equal(slow.ok, false)
  assert.equal(slow.timedOut, true)

  const controller = new AbortController()
  controller.abort()
  const aborted = await pollUntil(async () => null, { timeoutMs: 1000, signal: controller.signal })
  assert.equal(aborted.timedOut, true)
  assert.equal(aborted.attempts, 1)
})

// ── daemon budgets/timeouts ─────────────────────────────────────────────────

test('daemon: per-action budgets, with env override winning', () => {
  assert.equal(resolveBudget('navigate', 60000), ACTION_BUDGETS.navigate)
  assert.equal(resolveBudget('navigate', 60000), 15000)
  assert.equal(resolveBudget('unknown_action', 4242), 4242)
  assert.equal(resolveBudget('navigate', 60000, 900), 900)
  assert.equal(resolveBudget('obs_evaluate', 60000), ACTION_BUDGETS.obs_evaluate)
})

test('daemon: parses error envelopes and ignores success bodies', () => {
  assert.deepEqual(parseErrorBody('{"ok":false,"error":{"code":"tool_error","message":"nope"}}'), { code: 'tool_error', message: 'nope' })
  assert.equal(parseErrorBody('{"ok":true,"data":{}}'), null)
  assert.equal(parseErrorBody('not json'), null)
})

test('daemon: a hung call is reported as timedOut with unknown effects and is not retried', async () => {
  let hits = 0
  const server = createServer(() => { hits += 1 /* never respond */ })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  try {
    const daemon = createDaemonClient({
      daemonUrl: `http://127.0.0.1:${port}`, daemonBin: '/bin/false', timeoutMs: 5000, autostart: false, mock: false,
    })
    const res = await daemon.call('click', { selector: '#go' }, 's', { budgetMs: 150, mutating: true })
    assert.equal(res.ok, false)
    assert.equal(res.timedOut, true)
    assert.equal(res.budgetMs, 150)
    assert.equal(res.error.code, 'timeout')
    assert.equal(res.unknownEffects, true, 'mutating calls report unknown effects')
    assert.match(res.error.message, /client budget/)
    assert.equal(hits, 1, 'no automatic retry')

    const read = await daemon.call('snapshot', {}, 's', { budgetMs: 150 })
    assert.equal(read.timedOut, true)
    assert.equal(read.unknownEffects, false, 'reads are known to be harmless')
  } finally {
    server.closeAllConnections?.()
    await new Promise((resolve) => server.close(resolve))
  }
})

// ── obs / act against the fake daemon ───────────────────────────────────────

test('obs: one round trip, refs usable, stats honest', async () => {
  const { obs, session, daemon } = harness()
  const first = await obs({}, session)
  assert.equal(first.ok, true)
  assert.equal(first.stats.round_trips, 1, 'visible page costs exactly one page read')
  assert.equal(first.stats.reads, 1)
  assert.match(first.obs, /^o1$/)
  assert.ok(first.elements.length >= 5)
  assert.ok(first.elements.every((e) => e.ref.startsWith('o1:')))
  assert.ok(JSON.stringify(first).length <= 4000)
  assert.equal(first.keep_alive, undefined, 'no keep-alive work on a visible page')

  const second = await obs({}, session)
  assert.equal(second.obs, 'o2', 'generation advances')
  const st = await state(daemon, session)
  assert.equal(st.clicks.any, 0)
})

test('obs: a hidden page arms keep-alive and says so', async () => {
  const { obs, session, daemon } = harness()
  await daemon.call('evaluate', { code: 'mock:hide' }, session)
  const page = await obs({}, session)
  assert.equal(page.ok, true)
  assert.equal(page.stats.round_trips, 3, 'one read + focus emulation + lifecycle')
  assert.equal(page.keep_alive.focus_emulation, 'ok')
  assert.equal((await state(daemon, session)).focusEmulation, true)
})

test('act: a clean click is executed, delivered and lands on the intended element', async () => {
  const { obs, act, session, daemon } = harness()
  const page = await obs({}, session)
  const ref = findRef(page, 'Search')
  const result = await act({ ref, kind: 'click' }, session)
  assert.equal(result.ok, true)
  assert.equal(result.executed, true)
  assert.equal(result.stale, false)
  assert.equal(result.delivered, true)
  assert.equal(result.delivered_target_matches, true)
  assert.equal(result.delivered_trusted, true)
  const st = await state(daemon, session)
  assert.equal(st.clicks.any, 1)
  assert.equal(st.clicks.trusted, 1)
  assert.equal(st.clicks.lastTarget, 'Search')
})

test('act: semantic drift REFUSES and dispatches zero input (the P0 regression)', async () => {
  const { obs, act, session, daemon } = harness()
  const page = await obs({}, session)
  const ref = findRef(page, 'Where to?')
  await daemon.call('evaluate', { code: 'mock:rename' }, session)
  const result = await act({ ref, kind: 'click' }, session)
  assert.equal(result.executed, false)
  assert.equal(result.stale, true)
  assert.equal(result.no_input_dispatched, true)
  assert.equal(result.reason_code, 'semantic_drift')
  assert.match(result.reason, /semantic drift: name "Where to\?" → "Delete account"/)
  assert.deepEqual(result.what_changed, [{ field: 'name', from: 'Where to?', to: 'Delete account' }])
  assert.equal((await state(daemon, session)).clicks.any, 0, 'zero input dispatched')
  assert.ok(result.fresh, 'a refusal caused by drift carries a fresh observation')
  assert.equal(result.fresh.obs, 'o2')
})

test('act: a removed element REFUSES with zero input; a covered one too', async () => {
  const { obs, act, session, daemon } = harness()
  let page = await obs({}, session)
  const ref = findRef(page, 'Where to?')

  await daemon.call('evaluate', { code: 'mock:detach' }, session)
  const detached = await act({ ref, kind: 'click' }, session)
  assert.equal(detached.reason_code, 'detached')
  assert.equal(detached.no_input_dispatched, true)
  assert.equal((await state(daemon, session)).clicks.any, 0)

  // fresh page, then cover the target with an overlay
  page = await obs({}, session)
  assert.equal(page.elements.some((e) => e.name === 'Where to?'), false, 'detached element is not offered')
})

test('act: covered and off-viewport targets refuse with the geometric reason', async () => {
  const { obs, act, session, daemon } = harness()
  const page = await obs({}, session)
  const ref = findRef(page, 'Where to?')
  await daemon.call('evaluate', { code: 'mock:cover' }, session)
  const covered = await act({ ref, kind: 'click' }, session)
  assert.equal(covered.reason_code, 'covered')
  assert.equal(covered.no_input_dispatched, true)
  assert.equal(covered.covered_by.tag, 'DIV')

  await daemon.call('evaluate', { code: 'mock:uncover' }, session)
  await daemon.call('evaluate', { code: 'mock:shift' }, session)
  await daemon.call('evaluate', { code: 'mock:shift' }, session)
  const offscreen = await act({ ref, kind: 'click' }, session)
  assert.equal(offscreen.reason_code, 'outside viewport')
  assert.equal(offscreen.no_input_dispatched, true)
})

test('act: a target that only MOVED is still hit (geometry is re-resolved, not trusted)', async () => {
  const { obs, act, session, daemon } = harness()
  const page = await obs({}, session)
  const ref = findRef(page, 'Where to?')
  await daemon.call('evaluate', { code: 'mock:shift' }, session)
  const result = await act({ ref, kind: 'click' }, session)
  assert.equal(result.executed, true)
  assert.equal(result.delivered_target_matches, true)
  const st = await state(daemon, session)
  assert.equal(st.clicks.lastTarget, 'Where to?')
  assert.deepEqual(st.clicks.lastPoint, [110, 595], 'input went to the NEW geometry (rect y 80→580, center 595)')
})

test('act: a ref from an older observation still works while the meaning is unchanged', async () => {
  const { obs, act, session, daemon } = harness()
  const first = await obs({}, session)
  const ref = findRef(first, 'Search')
  await obs({}, session)            // a second observation happened
  const result = await act({ ref, kind: 'click' }, session)
  assert.equal(result.executed, true, 'identity-keyed refs survive later observations')
  assert.equal((await state(daemon, session)).clicks.lastTarget, 'Search')
})

test('act: unknown/malformed refs and bad arguments refuse without touching the page', async () => {
  const { obs, act, session, daemon } = harness()
  await obs({}, session)
  const unknown = await act({ ref: 'o9:99' }, session)
  assert.equal(unknown.no_input_dispatched, true)
  assert.match(unknown.reason, /unknown or expired ref/)
  const malformed = await act({ ref: 'e1' }, session)
  assert.match(malformed.reason, /malformed ref/)
  const noRef = await act({}, session)
  assert.match(noRef.reason, /requires ref/)
  const badKind = await act({ ref: 'o1:3', kind: 'teleport' }, session)
  assert.match(badKind.reason, /unsupported kind/)
  const noText = await act({ ref: 'o1:1', kind: 'fill' }, session)
  assert.match(noText.reason, /fill requires text/)
  const badKey = await act({ ref: 'o1:1', kind: 'press', key: 'F13' }, session)
  assert.match(badKey.reason, /press requires key/)
  assert.equal((await state(daemon, session)).clicks.any, 0)
})

test('act: fill lands (trusted input) with a verified read-back; "" clears', async () => {
  const { obs, act, session, daemon } = harness()
  const page = await obs({}, session)
  const ref = findRef(page, 'Where from?')
  const filled = await act({ ref, kind: 'fill', text: 'Paris' }, session)
  assert.equal(filled.executed, true)
  assert.equal(filled.verified, true)
  assert.equal(filled.verify.read_back, 'Paris')
  assert.equal(filled.verify.mode, 'trusted-input')
  assert.equal((await state(daemon, session)).values[1], 'Paris')

  const again = await obs({}, session)
  const ref2 = findRef(again, 'Where from?')
  assert.equal(again.elements.find((e) => e.ref === ref2).value, 'Paris', 'the observation reflects the new value')
  const cleared = await act({ ref: ref2, kind: 'fill', text: '' }, session)
  assert.equal(cleared.verified, true)
  assert.equal((await state(daemon, session)).values[1], '')
})

test('act: when trusted insertText is not enough the DOM fallback is used and reported', async () => {
  const { obs, act, session, daemon } = harness()
  const page = await obs({}, session)
  const ref = findRef(page, 'Where from?')
  // verify_delivery:false means no probe is armed, so the fake daemon's
  // insertText (which writes to the armed node) cannot land → fallback path.
  const filled = await act({ ref, kind: 'fill', text: 'Berlin', verify_delivery: false }, session)
  assert.equal(filled.verified, true)
  assert.match(filled.mode, /dom-fallback/)
  assert.equal(filled.verify.mode, 'dom-fallback')
  assert.equal((await state(daemon, session)).values[1], 'Berlin')
})

test('act: press refuses a non-editable target and sends real keys to an editable one', async () => {
  const { obs, act, session, daemon } = harness()
  const page = await obs({}, session)
  const refused = await act({ ref: findRef(page, 'Search'), kind: 'press', key: 'Enter' }, session)
  assert.equal(refused.reason_code, 'press_needs_editable')
  assert.equal(refused.no_input_dispatched, true)

  const ok = await act({ ref: findRef(page, 'Where from?'), kind: 'press', key: 'Enter' }, session)
  assert.equal(ok.executed, true)
  const st = await state(daemon, session)
  assert.deepEqual(st.keys, ['Enter'])
  assert.ok(KEYS.Enter.windowsVirtualKeyCode === 13)
})

test('act: select sets the option and verifies the read-back', async () => {
  const { obs, act, session } = harness()
  const page = await obs({}, session)
  const result = await act({ ref: findRef(page, 'Search'), kind: 'select', value: 'mock' }, session)
  assert.equal(result.executed, true)
  assert.equal(result.mode, 'dom-select')
})

test('act: a timed-out precondition check reports timedOut and dispatches nothing', async () => {
  const { cfg, store, obs } = harness()
  const timedOutCall = async (action) => (action === 'evaluate'
    ? { ok: false, error: { code: 'timeout', message: 'boom' }, timedOut: true, budgetMs: 10, action }
    : { ok: true, data: {}, ms: 1, action })
  const act = createActHandler({ call: timedOutCall, store, cfg, obs })
  await obs({}, 's')
  const result = await act({ ref: 'o1:3' }, 's')
  assert.equal(result.timedOut, true)
  assert.equal(result.no_input_dispatched, true)
  assert.match(result.reason, /nothing was dispatched/)
})

// ── open_tab ────────────────────────────────────────────────────────────────

test('open_tab: creates a background tab, identifies it by tab-id diff and reports readiness', async () => {
  const { daemon, session } = harness()
  const result = await openTab(daemon.call, session, {
    url: 'https://mock.test/app',
    userTabProbe: () => ({ via: 'test', url: 'https://mock.test/anchor' }),
  })
  assert.equal(result.ok, true)
  assert.equal(result.method, 'create')
  assert.equal(result.background, true)
  assert.equal(result.ready, true)
  assert.equal(result.ready_state, 'complete')
  assert.equal(result.keep_alive.focus_emulation, 'ok')
  assert.ok(result.targetId)
  assert.equal(result.anchor.borrowed, true)

  const tabs = (await daemon.call('list_tabs', {}, session)).data.tabs
  assert.equal(tabs.length, 2, 'anchor + created tab')
  assert.equal(tabs.find((t) => t.tabId === result.tabId).url, 'https://mock.test/app')
})

test('open_tab: reuses a tab that is already inside the requested subtree', async () => {
  const { daemon, session } = harness()
  const first = await openTab(daemon.call, session, { url: 'https://mock.test/app/deep', userTabProbe: () => ({ via: 'test', url: 'https://mock.test/anchor' }) })
  assert.equal(first.method, 'create')
  // asking for the parent path must reuse the deeper tab (redirect/normalisation case)
  const again = await openTab(daemon.call, session, { url: 'https://mock.test/app', userTabProbe: () => ({ via: 'test', url: 'https://mock.test/anchor' }) })
  assert.equal(again.method, 'reuse')
  assert.equal(again.tabId, first.tabId)
  assert.equal(again.reused, true)
  // a sibling path is a different page: navigate INSIDE the tab we own — never
  // create another tab (a second create is the thing that leaves orphans)
  const third = await openTab(daemon.call, session, { url: 'https://mock.test/other', userTabProbe: () => ({ via: 'test', url: 'https://mock.test/anchor' }) })
  assert.equal(third.method, 'navigate_in_tab')
  assert.equal(third.tabId, first.tabId)
  assert.equal(third.new_tab, false)
  assert.equal(third.url, 'https://mock.test/other')
  const tabs = (await daemon.call('list_tabs', {}, session)).data.tabs
  assert.equal(tabs.length, 2, 'anchor + the one tab we own')
  assert.equal(tabs.find((t) => t.tabId === first.tabId).url, 'https://mock.test/other')
})

test('open_tab: navigates inside an owned tab without touching the session anchor', async () => {
  const { daemon, session } = harness()
  const first = await openTab(daemon.call, session, { url: 'https://mock.test/app', userTabProbe: () => ({ via: 'test', url: 'https://mock.test/anchor' }) })
  const anchorUrlBefore = (await daemon.call('list_tabs', {}, session)).data.tabs.find((t) => t.borrowed === true)?.url
  const second = await openTab(daemon.call, session, { url: 'https://mock.test/step2', userTabProbe: () => ({ via: 'test', url: 'https://mock.test/anchor' }) })
  assert.equal(second.method, 'navigate_in_tab')
  assert.equal(second.session_bound, true)
  assert.equal(second.cdp_ms >= 0, true)
  const anchorUrlAfter = (await daemon.call('list_tabs', {}, session)).data.tabs.find((t) => t.borrowed === true)?.url
  assert.equal(anchorUrlBefore, anchorUrlAfter, 'the borrowed user tab was never navigated')
  assert.equal((await daemon.call('list_tabs', {}, session)).data.tabs.find((t) => t.tabId === first.tabId).url, 'https://mock.test/step2')
})

test('open_tab: borrows the tab already in front when it is the requested URL', async () => {
  const { daemon, session, guard } = harness({ withGuard: true })
  const result = await openTab(daemon.call, session, {
    url: 'https://mock.test/infront',
    userTabProbe: () => ({ via: 'test', url: 'https://mock.test/infront' }),
    guard,
  })
  assert.equal(result.ok, true)
  assert.equal(result.method, 'borrow_matching')
  assert.equal(result.borrowed, true)
  assert.equal(result.owned, false)
  assert.equal(result.do_not_close, true)
  assert.equal(guard.state(session).bound, true)
  assert.equal(guard.state(session).borrowed, true)
  assert.equal(guard.isAnchor(session, result.tabId), true)
})

test('open_tab: a tab borrowed from the user is never used as a navigation target', async () => {
  const { daemon, session } = harness()
  // the session's only tab is a user tab (borrowed as an anchor in an earlier run)
  await daemon.call('find_tab', { url: 'https://mock.test/user-page', active: true }, session)
  const navigated = await openTab(daemon.call, session, {
    url: 'https://mock.test/ours',
    canCreate: false,
    userTabProbe: () => ({ via: 'test', url: 'https://mock.test/somewhere-else' }),
  })
  assert.equal(navigated.ok, false)
  assert.match(navigated.reason, /creation is disabled/)
  const userTab = (await daemon.call('list_tabs', {}, session)).data.tabs.find((t) => t.borrowed === true)
  assert.equal(userTab.url, 'https://mock.test/user-page', "the user's tab was left alone")
})

test('open_tab: a failed create leaves the session UNTRUSTED and obs/act refuse', async () => {
  const { daemon, session, guard, obs, act, calls } = harness({ withGuard: true })
  // a browser that creates a tab but never lets the extension bind it
  const call = async (action, args, sess, opts) => {
    if (action === 'cdp' && args.method === 'Target.createTarget') {
      return { ok: true, data: { targetId: 'orphan-target' }, ms: 1, action }
    }
    calls.push({ action, args })
    return daemon.call(action, args, sess, opts)
  }
  const failed = await openTab(call, session, {
    url: 'https://mock.test/app',
    adoptTimeoutMs: 200,
    userTabProbe: () => ({ via: 'test', url: 'https://mock.test/user-business-system' }),
    guard,
  })
  assert.equal(failed.ok, false)
  assert.equal(failed.created, true)
  assert.equal(failed.adopted, false)
  assert.equal(failed.orphan_warning, true)
  assert.equal(failed.session_bound, false)
  assert.match(failed.hint, /orphan/)
  assert.equal(guard.check(session).allowed, false, 'the session is no longer trusted')

  // the safety property: no page was read from the borrowed user tab
  const readsBefore = calls.filter((c) => c.action === 'evaluate' && c.args?.code?.includes('__wb:snapshot')).length
  const refusedObs = await obs({}, session)
  assert.equal(refusedObs.ok, false)
  assert.equal(refusedObs.reason_code, 'session_unbound')
  assert.match(refusedObs.reason, /not trusted/)
  assert.equal(calls.filter((c) => c.action === 'evaluate' && c.args?.code?.includes('__wb:snapshot')).length, readsBefore, 'obs refused BEFORE reading the page')

  const refusedAct = await act({ ref: 'o1:1', kind: 'click' }, session)
  assert.equal(refusedAct.ok, false)
  assert.equal(refusedAct.reason_code, 'session_unbound')
  assert.equal(refusedAct.no_input_dispatched, true)

  // explicit override still works (the caller knows what it is doing)
  const override = await obs({ allow_any_tab: true }, session)
  assert.equal(override.ok, true)

  // and a later successful binding clears the block
  guard.bind(session, { url: 'https://mock.test/app', source: 'test' })
  const afterBind = await obs({}, session)
  assert.equal(afterBind.ok, true)
})

test('session guard: bind/unbind/check/markAnchor lifecycle', () => {
  const guard = createSessionGuard()
  assert.equal(guard.check('s').allowed, true, 'unknown sessions are allowed (legacy flows)')
  guard.bind('s', { url: 'https://a.test/', source: 'test' })
  assert.equal(guard.check('s').allowed, true)
  guard.markAnchor('s', 42)
  assert.equal(guard.isAnchor('s', 42), true)
  assert.equal(guard.isAnchor('s', 43), false)
  guard.unbind('s', { reason: 'the working tab was closed', source: 'close_tab' })
  const verdict = guard.check('s')
  assert.equal(verdict.allowed, false)
  assert.match(verdict.reason, /working tab was closed/)
  assert.match(verdict.hint, /open_tab/)
  guard.bind('s', { url: 'https://b.test/', source: 'test' })
  assert.equal(guard.check('s').allowed, true, 're-binding clears the block')
  guard.forget('s')
  assert.equal(guard.check('s').allowed, true)
})

test('open_tab: without an anchor it fails loudly and explains what to do', async () => {
  const { daemon, session } = harness()
  const result = await openTab(daemon.call, session, { url: 'https://mock.test/app', userTabProbe: () => null })
  assert.equal(result.ok, false)
  assert.match(result.reason, /no anchor tab/)
  assert.match(result.hint, /cdp needs an attached tab/)
  // nothing was created
  assert.equal((await daemon.call('list_tabs', {}, session)).data.tabs.length, 0)
})

test('open_tab: a created tab whose url we cannot confirm is refused, not guessed', async () => {
  const { daemon, session } = harness()
  // Emulate a browser that normalises the URL to somewhere we did not ask for.
  const call = async (action, args, sess, opts) => {
    if (action === 'cdp' && args.method === 'Target.createTarget') {
      const created = await daemon.call(action, { ...args, params: { ...args.params, url: 'https://mock.test/somewhere-else' } }, sess, opts)
      return created
    }
    return daemon.call(action, args, sess, opts)
  }
  const result = await openTab(call, session, { url: 'https://mock.test/app', userTabProbe: () => ({ via: 'test', url: 'https://mock.test/anchor' }) })
  assert.equal(result.ok, false)
  assert.equal(result.created, true)
  assert.equal(result.session_bound, false)
  assert.match(result.reason, /unexpected url/)
  assert.equal(result.wrong_url, 'https://mock.test/somewhere-else')
  assert.match(result.hint, /orphan/)
})

test('resolveBudget default config: readConfig maps env knobs', async () => {
  const { readConfig } = await import('../lib/daemon.mjs')
  const cfg = readConfig({
    WEBBRIDGE_MCP_OBS_TIMEOUT_MS: '1234', WEBBRIDGE_MCP_ACT_TIMEOUT_MS: '111',
    WEBBRIDGE_MCP_ACT_INPUT_TIMEOUT_MS: '222', WEBBRIDGE_MCP_OBS_MAX_CHARS: '777',
    WEBBRIDGE_MCP_MOCK: '1', WEBBRIDGE_MCP_DEBUG: '1',
  })
  assert.equal(cfg.obsTimeoutMs, 1234)
  assert.equal(cfg.actCheckTimeoutMs, 111)
  assert.equal(cfg.actInputTimeoutMs, 222)
  assert.equal(cfg.obsMaxChars, 777)
  assert.equal(cfg.mock, true)
  assert.equal(cfg.debug, true)
  assert.equal(readConfig({}).obsMaxChars, 4000)
})
