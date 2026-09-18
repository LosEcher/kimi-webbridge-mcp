/**
 * Mock page model (WEBBRIDGE_MCP_MOCK=1) — a tiny stateful stand-in for the
 * daemon + page, so the obs → act → refuse/execute flow can be exercised in CI
 * with no browser and no DOM.
 *
 * It emulates the daemon contract for the actions this server uses and answers
 * the wrapper's page snippets by their `__wb:<name>` sentinel, applying the SAME
 * preconditions as lib/check.page.js (detached / disabled / invisible /
 * outside viewport / covered) plus a real click counter, so a refusal can be
 * asserted to have dispatched zero input.
 *
 * Test-only control channel: `evaluate { code: "mock:<command>" }`.
 *   mock:state | mock:rename | mock:detach | mock:shift | mock:cover |
 *   mock:disable | mock:uncover | mock:clear-clicks
 */

const ELEMENTS = () => ([
  { node: 1, role: 'textbox', name: 'Where from?', kind: 'fill', value: '', rect: [10, 40, 200, 30], scope: 'Search form', connected: true, disabled: false, invisible: false, covered: false },
  { node: 2, role: 'textbox', name: 'Where to?', kind: 'fill', value: '', rect: [10, 80, 200, 30], scope: 'Search form', connected: true, disabled: false, invisible: false, covered: false },
  { node: 3, role: 'button', name: 'Search', kind: 'click', value: null, rect: [230, 120, 90, 30], scope: 'Search form', connected: true, disabled: false, invisible: false, covered: false },
  { node: 4, role: 'checkbox', name: 'Nonstop only', kind: 'click', value: null, checked: false, rect: [10, 160, 20, 20], scope: 'Search form', connected: true, disabled: false, invisible: false, covered: false },
  { node: 5, role: 'link', name: 'Account', kind: 'click', value: null, href: '#account', rect: [300, 10, 80, 20], scope: '', connected: true, disabled: false, invisible: false, covered: false },
])

export function createMockPage({ url = 'https://mock.test/fixture' } = {}) {
  const state = {
    url,
    title: 'Mock fixture',
    epoch: 1,
    timeOrigin: 1000,
    w: 1280,
    h: 800,
    scrollY: 0,
    elements: ELEMENTS(),
    values: {},
    clicks: { any: 0, trusted: 0, dom: 0, lastTarget: null, lastPoint: null },
    keys: [],
    focusEmulation: false,
    tabs: [],
    nextTabId: 100,
  }
  const byNode = (node) => state.elements.find((e) => e.node === node)

  const guard = (el) => (el.connected && !el.invisible ? {
    node: el.node,
    role: el.role,
    name: el.name,
    value: 'value' in el && el.kind === 'fill' ? (state.values[el.node] ?? el.value ?? '') : (el.value ?? null),
    checked: el.checked ?? null,
    selectedIndex: null,
    readOnly: false,
    disabled: el.disabled === true,
    ariaDisabled: null, ariaExpanded: null, ariaChecked: null, ariaSelected: null,
    href: el.href ?? null,
    scope: el.scope ?? '',
  } : null)

  const pageKey = () => [state.timeOrigin, state.url, state.w, state.h]

  const snapshot = () => JSON.stringify({
    url: state.url,
    title: state.title,
    w: state.w,
    h: state.h,
    pageKey: pageKey(),
    text: state.elements.map((e) => e.name).join('\n'),
    textChars: state.elements.reduce((n, e) => n + e.name.length, 0),
    scroll: { y: state.scrollY, height: 3000 },
    hidden: state.focusEmulation ? false : state.hidden === true,
    visibility: state.hidden === true && !state.focusEmulation ? 'hidden' : 'visible',
    focused: true,
    elements: state.elements.filter((e) => e.connected && !e.invisible && !e.disabled && !e.covered).map((e) => ({
      node: e.node, role: e.role, name: e.name, kind: e.kind,
      ...(e.kind === 'fill' ? { value: state.values[e.node] ?? e.value ?? '' } : {}),
      ...(e.checked !== undefined ? { checked: String(e.checked) } : {}),
      scope: e.scope,
      rect: e.rect,
    })),
    guards: Object.fromEntries(state.elements.filter((e) => e.connected && !e.invisible).map((e) => [e.node, guard(e)])),
    activeNode: null,
    omittedElements: 0,
    stats: { elements: state.elements.length, guards: state.elements.length, text_chars: 40 },
  })

  const check = (node) => {
    const el = byNode(node)
    if (!el) return { ok: false, reason: 'node gone', detail: 'mock: unknown node' }
    if (!el.connected) return { ok: false, reason: 'detached', detail: 'the element was removed from the document' }
    if (el.disabled) return { ok: false, reason: 'disabled', detail: 'the element is disabled or inside an inert subtree' }
    if (el.invisible) return { ok: false, reason: 'invisible', detail: 'the element is hidden (display/visibility/opacity)' }
    const [rx, ry, rw, rh] = el.rect
    const x = rx + rw / 2
    const y = ry + rh / 2
    if (x < 0 || y < 0 || x >= state.w || y >= state.h) {
      return { ok: false, reason: 'outside viewport', detail: `center (${Math.round(x)}, ${Math.round(y)}) is outside ${state.w}x${state.h}`, point: [Math.round(x), Math.round(y)] }
    }
    if (el.covered) {
      return { ok: false, reason: 'covered', detail: `point (${Math.round(x)}, ${Math.round(y)}) is covered`, by: { tag: 'DIV', label: 'overlay' }, point: [Math.round(x), Math.round(y)] }
    }
    return { ok: true, x, y, pageKey: pageKey(), guard: guard(el), hit: { tag: el.role === 'button' ? 'BUTTON' : 'DIV', label: el.name } }
  }

  const hitTest = (x, y) => state.elements.find((el) => {
    if (!el.connected || el.invisible || el.covered) return false
    const [rx, ry, rw, rh] = el.rect
    return x >= rx && x <= rx + rw && y >= ry && y <= ry + rh
  }) ?? null

  const nodeFromCode = (code) => {
    // Either `(<fn>)(12)` or an inlined `node = 12` inside the snippet.
    const call = /\)\((\d+)\)\s*$/.exec(code)
    if (call) return Number(call[1])
    const inlined = /node = (\d+)/.exec(code)
    if (inlined) return Number(inlined[1])
    const looked = /nodes\.get\((\d+)\)/.exec(code)
    return looked ? Number(looked[1]) : null
  }

  const evaluate = (code) => {
    if (typeof code !== 'string') return { value: null }
    const sentinel = /\/\*__wb:(\w+)\*\//.exec(code)
    if (sentinel) {
      const name = sentinel[1]
      if (name === 'snapshot') return { type: 'string', value: snapshot() }
      if (name === 'check') return { type: 'string', value: JSON.stringify(check(nodeFromCode(code))) }
      if (name === 'probeArm') { state.armedNode = nodeFromCode(code); state.probe = null; return { type: 'number', value: 1 } }
      if (name === 'probeRead') {
        return { type: 'string', value: JSON.stringify({ probe: state.probe ?? null, pageKey: pageKey(), href: state.url }) }
      }
      if (name === 'readValue') {
        const node = nodeFromCode(code)
        const el = byNode(node)
        if (!el) return { type: 'string', value: JSON.stringify({ gone: true }) }
        return { type: 'string', value: JSON.stringify({ value: state.values[node] ?? el.value ?? '', focused: false, tag: el.role === 'checkbox' ? 'INPUT' : 'INPUT' }) }
      }
      if (name === 'selectAll') return { type: 'string', value: JSON.stringify({ ok: true, mode: 'select' }) }
      if (name === 'domSetValue') {
        const node = nodeFromCode(code)
        const m = /text = ("(?:[^"\\]|\\.)*")/.exec(code)
        if (node !== null && m) state.values[node] = JSON.parse(m[1])
        return { type: 'string', value: JSON.stringify({ ok: true }) }
      }
      if (name === 'domSelect') return { type: 'string', value: JSON.stringify({ ok: true, selectedIndex: 1, value: 'mock' }) }
      return { type: 'null', value: null }
    }
    if (code.startsWith('mock:')) {
      const [command, arg] = code.slice(5).split(':')
      const el = arg ? byNode(Number(arg)) : byNode(2)
      if (!el) return { __error: `mock: no element ${arg}` }
      if (command === 'rename') { el.name = 'Delete account' }
      else if (command === 'detach') { el.connected = false }
      else if (command === 'shift') { el.rect = [el.rect[0], el.rect[1] + 500, el.rect[2], el.rect[3]] }
      else if (command === 'cover') { el.covered = true }
      else if (command === 'uncover') { el.covered = false }
      else if (command === 'disable') { el.disabled = true }
      else if (command === 'clear-clicks') { state.clicks = { any: 0, trusted: 0, dom: 0, lastTarget: null, lastPoint: null } }
      else if (command === 'hide') { state.hidden = true }
      else if (command === 'show') { state.hidden = false }
      else if (command === 'state') return { type: 'string', value: JSON.stringify(state) }
      else return { __error: `unknown mock command ${command}` }
      return { type: 'string', value: JSON.stringify({ command }) }
    }
    if (code.includes('document.readyState')) {
      return { type: 'string', value: `complete|${state.url}` }
    }
    return { type: 'null', value: null }
  }

  const cdp = (method, params = {}) => {
    if (method === 'Input.dispatchMouseEvent') {
      if (params.type === 'mousePressed') {
        const hit = hitTest(params.x, params.y)
        state.clicks.any += 1
        state.clicks.trusted += 1
        state.clicks.lastPoint = [params.x, params.y]
        state.clicks.lastTarget = hit ? hit.name : null
        state.probe = { fired: true, type: 'mousedown', trusted: true, target: hit ? (hit.role === 'button' ? `BUTTON#${hit.node}` : `DIV#${hit.node}`) : null, matched: hit ? hit.node === state.armedNode : false }
        if (hit && hit.kind === 'click' && hit.role === 'checkbox') { hit.checked = !hit.checked }
        if (hit && hit.role === 'button') state.submitted = true
      }
      return {}
    }
    if (method === 'Input.insertText') {
      const el = byNode(state.armedNode)
      if (el) state.values[el.node] = params.text
      return {}
    }
    if (method === 'Input.dispatchKeyEvent') {
      if (params.type !== 'keyUp') state.keys.push(params.key)
      return {}
    }
    if (method === 'Emulation.setFocusEmulationEnabled') {
      state.focusEmulation = params.enabled === true
      return {}
    }
    if (method === 'Page.setWebLifecycleState') return {}
    return {}
  }

  return { state, evaluate, cdp, snapshot, check, hitTest, armProbe: (node) => { state.armedNode = node; state.probe = null } }
}
