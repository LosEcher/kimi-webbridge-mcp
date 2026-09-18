/**
 * `act` — guarded execution.
 *
 * Order of operations, and why:
 *   1. resolve the ref to the node identity the decision was made about;
 *   2. ONE in-page check that re-resolves geometry, re-tests occlusion and
 *      re-reads the semantic guard (nothing is dispatched from that call);
 *   3. refuse — dispatching NOTHING — when the node is gone, disabled, hidden,
 *      covered, off-viewport, on another page, or no longer means the same thing;
 *   4. only then dispatch real input through `Input.*` (CDP), and verify that the
 *      event actually reached the intended node (or that the value landed).
 *
 * The refusal is the product: the two backends this replaces both answer
 * `success:true` for a renamed or removed element, which is how "the agent says
 * it clicked and the page did nothing" happens.
 *
 * Timed-out calls are reported as `timedOut` + `unknown_effects` and never
 * retried: an input may have been applied after the client gave up.
 */
import { readFileSync } from 'node:fs'
import { describePageKeyChange, guardDiff, pageKeyChanged, summarizeDiff } from './refs.mjs'

const CHECK_SRC = readFileSync(new URL('./check.page.js', import.meta.url), 'utf8')

export const ACT_CHECK_SOURCE = CHECK_SRC

/** Keys `press` can send, with the virtual key codes Chrome expects. */
export const KEYS = Object.freeze({
  Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
  Backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 },
  Space: { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' },
})

const EDITABLE_ROLES = new Set(['textbox', 'searchbox', 'spinbutton', 'combobox'])
export const KINDS = Object.freeze(['click', 'fill', 'press', 'select'])
const PROBE_EVENTS = ['pointerdown', 'mousedown', 'click']

const probeArm = (node) => `/*__wb:probeArm*/ (() => {
  const cache = window.__wbObs, node = ${node};
  const h = (ev) => {
    const e = cache && cache.nodes.get(node);
    window.__wbProbe = {
      fired: true, type: ev.type, trusted: ev.isTrusted === true,
      target: ev.target && ev.target.tagName ? ev.target.tagName + (ev.target.id ? '#' + ev.target.id : '') : null,
      matched: !!(e && ev.target && (ev.target === e || e.contains(ev.target))),
    };
    for (const t of ${JSON.stringify(PROBE_EVENTS)}) document.removeEventListener(t, h, true);
    window.__wbProbeHandler = null;
  };
  for (const t of ${JSON.stringify(PROBE_EVENTS)}) document.addEventListener(t, h, true);
  window.__wbProbeHandler = h; window.__wbProbe = null;
  return 1;
})()`

const PROBE_READ = `/*__wb:probeRead*/ (() => {
  const h = window.__wbProbeHandler;
  if (h) {
    for (const t of ${JSON.stringify(PROBE_EVENTS)}) document.removeEventListener(t, h, true);
    window.__wbProbeHandler = null;
  }
  const probe = window.__wbProbe || null; window.__wbProbe = null;
  return JSON.stringify({ probe, pageKey: window.__wbObs ? window.__wbObs.pageKey() : null, href: location.href });
})()`

const readValue = (node) => `/*__wb:readValue*/ (() => {
  const cache = window.__wbObs, e = cache && cache.nodes.get(${node});
  if (!e) return JSON.stringify({ gone: true });
  const value = ('value' in e) ? String(e.value) : (e.isContentEditable ? e.innerText : '');
  return JSON.stringify({ value, focused: document.activeElement === e, tag: e.tagName });
})()`

const selectAll = (node) => `/*__wb:selectAll*/ (() => {
  const cache = window.__wbObs, e = cache && cache.nodes.get(${node});
  if (!e) return JSON.stringify({ ok: false, reason: 'gone' });
  e.focus();
  if (typeof e.select === 'function' && !e.isContentEditable) { e.select(); return JSON.stringify({ ok: true, mode: 'select' }); }
  if (e.isContentEditable) { document.execCommand('selectAll'); return JSON.stringify({ ok: true, mode: 'execCommand' }); }
  return JSON.stringify({ ok: false, reason: 'not selectable' });
})()`

const domSetValue = (node, textJson) => `/*__wb:domSetValue*/ (() => {
  const cache = window.__wbObs, e = cache && cache.nodes.get(${node}), text = ${textJson};
  if (!e) return JSON.stringify({ ok: false, reason: 'gone' });
  e.focus();
  if (e.isContentEditable) {
    e.textContent = text;
  } else {
    const proto = e.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value') && Object.getOwnPropertyDescriptor(proto, 'value').set;
    if (setter) setter.call(e, text); else e.value = text;
  }
  e.dispatchEvent(new Event('input', { bubbles: true }));
  e.dispatchEvent(new Event('change', { bubbles: true }));
  return JSON.stringify({ ok: true });
})()`

const domSelectOption = (node, valueJson) => `/*__wb:domSelect*/ (() => {
  const cache = window.__wbObs, e = cache && cache.nodes.get(${node}), want = ${valueJson};
  if (!e) return JSON.stringify({ ok: false, reason: 'gone' });
  if (e.tagName !== 'SELECT') return JSON.stringify({ ok: false, reason: 'not a select' });
  e.focus();
  e.value = want;
  e.dispatchEvent(new Event('input', { bubbles: true }));
  e.dispatchEvent(new Event('change', { bubbles: true }));
  return JSON.stringify({ ok: true, selectedIndex: e.selectedIndex, value: e.value });
})()`

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Summarise the freshly observed meaning of a node for a refusal payload. */
export function observedSummary(guard) {
  if (!guard) return null
  const out = { role: guard.role ?? null, name: guard.name ?? null }
  if (guard.value !== null && guard.value !== undefined && guard.value !== '') out.value = guard.value
  if (guard.checked !== null && guard.checked !== undefined) out.checked = guard.checked
  if (guard.href) out.href = guard.href
  return out
}

/**
 * @param {object} deps
 * @param {Function} deps.call daemon transport
 * @param {object} deps.store observation store
 * @param {object} deps.cfg
 * @param {Function} deps.obs obs handler, used to embed a fresh observation in drift refusals
 * @param {object} [deps.guard] session guard: refuses to act when the session's
 *   working tab is not known to be ours
 */
export function createActHandler({ call, store, cfg, obs, guard = null }) {
  const debugLog = (message) => {
    if (cfg.debug) process.stderr.write(`[webbridge-mcp] ${message}\n`)
  }

  async function dispatchMouseClick(session, x, y) {
    const sequence = [
      ['mouseMoved', { x, y, button: 'none', buttons: 0 }],
      ['mousePressed', { x, y, button: 'left', buttons: 1, clickCount: 1 }],
      ['mouseReleased', { x, y, button: 'left', buttons: 0, clickCount: 1 }],
    ]
    const calls = []
    let dispatched = 0
    for (const [type, params] of sequence) {
      const res = await call('cdp', { method: 'Input.dispatchMouseEvent', params: { type, ...params } }, session, { budgetMs: cfg.actInputTimeoutMs })
      calls.push({ type, ok: res.ok, ms: res.ms, error: res.error?.message ?? null })
      if (!res.ok) {
        return { ok: false, calls, dispatched, failedType: type, error: res.error, timedOut: res.timedOut === true }
      }
      dispatched += 1
    }
    return { ok: true, calls, dispatched }
  }

  async function dispatchKey(session, spec) {
    const base = { key: spec.key, code: spec.code, windowsVirtualKeyCode: spec.windowsVirtualKeyCode, nativeVirtualKeyCode: spec.windowsVirtualKeyCode }
    const down = await call('cdp', {
      method: 'Input.dispatchKeyEvent',
      params: { type: spec.text ? 'keyDown' : 'rawKeyDown', ...base, ...(spec.text ? { text: spec.text, unmodifiedText: spec.text } : {}) },
    }, session, { budgetMs: cfg.actInputTimeoutMs })
    const up = await call('cdp', { method: 'Input.dispatchKeyEvent', params: { type: 'keyUp', ...base } }, session, { budgetMs: cfg.actInputTimeoutMs })
    return {
      ok: down.ok && up.ok,
      calls: [
        { type: 'keyDown', ok: down.ok, ms: down.ms, error: down.error?.message ?? null },
        { type: 'keyUp', ok: up.ok, ms: up.ms, error: up.error?.message ?? null },
      ],
      dispatched: (down.ok ? 1 : 0) + (up.ok ? 1 : 0),
      timedOut: down.timedOut === true || up.timedOut === true,
    }
  }

  return async function act(args, session) {
    const started = Date.now()
    const ref = typeof args.ref === 'string' ? args.ref.trim() : ''
    const kind = typeof args.kind === 'string' ? args.kind : 'click'
    const settleMs = Number.isFinite(args.settle_ms) ? Number(args.settle_ms) : 40
    const verifyDelivery = args.verify_delivery !== false
    const wantRefresh = args.refresh !== false

    if (!ref) return { ok: false, executed: false, stale: false, no_input_dispatched: true, reason: 'act requires ref (from obs)', ref_hint: 'call obs, then act on one of its refs' }
    if (guard && args.allow_any_tab !== true) {
      const verdict = guard.check(session)
      if (!verdict.allowed) {
        return {
          ok: false, executed: false, stale: false, no_input_dispatched: true,
          ref, kind, reason_code: 'session_unbound', reason: verdict.reason, hint: verdict.hint,
          session_state: verdict.state ? { bound: verdict.state.bound, url: verdict.state.url, source: verdict.state.source } : null,
        }
      }
    }
    if (!KINDS.includes(kind)) {
      return { ok: false, executed: false, stale: false, no_input_dispatched: true, ref, reason: `unsupported kind ${JSON.stringify(kind)}`, supported: KINDS }
    }
    if (kind === 'fill' && typeof args.text !== 'string') {
      return { ok: false, executed: false, stale: false, no_input_dispatched: true, ref, kind, reason: 'fill requires text (a string; use "" to clear)' }
    }
    if (kind === 'select' && typeof args.value !== 'string') {
      return { ok: false, executed: false, stale: false, no_input_dispatched: true, ref, kind, reason: 'select requires value (the option value from obs)' }
    }
    if (kind === 'press' && (typeof args.key !== 'string' || !(args.key in KEYS))) {
      return {
        ok: false, executed: false, stale: false, no_input_dispatched: true, ref, kind,
        reason: `press requires key to be one of ${Object.keys(KEYS).join(', ')}`,
      }
    }

    const lookup = store.get(session, ref)
    if (lookup.error) {
      return { ok: false, executed: false, stale: true, no_input_dispatched: true, ref, kind, reason: lookup.error, ref_hint: 'call obs to re-resolve the element' }
    }
    const entry = lookup.entry
    if (kind !== 'press' && entry.kind && entry.kind !== kind) {
      // Not fatal (a fill target can still be clicked to focus it), but tell the truth.
      debugLog(`act: ref ${ref} was offered as ${entry.kind}, acting as ${kind}`)
    }

    const finish = (payload) => ({ ...payload, ref, kind, total_ms: Date.now() - started })

    const maybeFresh = async (payload) => {
      if (!wantRefresh) return finish(payload)
      const fresh = await obs({ keep_alive: false }, session)
      if (fresh && fresh.ok) {
        return finish({
          ...payload,
          fresh: { obs: fresh.obs, url: fresh.url, title: fresh.title, elements: fresh.elements, omitted: fresh.omitted, stats: fresh.stats },
          fresh_hint: 'element refs above are from this fresh observation; the ref you used is no longer valid',
        })
      }
      return finish(payload)
    }

    const refuse = (reason, extra = {}, { refresh = false } = {}) => {
      const payload = {
        ok: false, executed: false, stale: true, no_input_dispatched: true,
        reason, reason_code: extra.reason_code ?? 'refused',
        ...extra,
      }
      debugLog(`act refused session=${session} ${ref} ${kind}: ${reason}`)
      return refresh ? maybeFresh(payload) : finish(payload)
    }

    // ── 1. one in-page precondition check (pure read) ─────────────────────────
    const check = await call('evaluate', { code: `(${CHECK_SRC})(${entry.node})` }, session, { budgetMs: cfg.actCheckTimeoutMs })
    if (!check.ok) {
      return finish({
        ok: false, executed: false, stale: false, no_input_dispatched: true,
        reason: check.timedOut
          ? `precondition check timed out after ${check.budgetMs} ms — nothing was dispatched`
          : `precondition check failed: ${check.error?.message ?? 'unknown error'} — nothing was dispatched`,
        timedOut: check.timedOut === true,
        check_ms: check.ms,
      })
    }
    let observed
    const rawCheck = check.data?.value
    if (rawCheck && typeof rawCheck === 'object') {
      observed = rawCheck            // some transports decode the value already
    } else {
      try {
        observed = JSON.parse(rawCheck)
      } catch (error) {
        return finish({ ok: false, executed: false, stale: false, no_input_dispatched: true, reason: `precondition check returned malformed JSON: ${error.message}`, check_ms: check.ms })
      }
    }

    if (!observed.ok) {
      const refreshable = ['detached', 'node gone'].includes(observed.reason)
      return refuse(`element is no longer actionable: ${observed.reason}${observed.detail ? ` (${observed.detail})` : ''}`, {
        reason_code: observed.reason,
        detail: observed.detail ?? null,
        covered_by: observed.by ?? null,
        point: observed.point ?? null,
        check_ms: check.ms,
      }, { refresh: refreshable })
    }

    // ── 2. freshness: page identity then the node's meaning ──────────────────
    if (pageKeyChanged(entry.pageKey, observed.pageKey)) {
      const detail = describePageKeyChange(entry.pageKey, observed.pageKey)
      return refuse(`the page changed since the decision: ${detail}`, {
        reason_code: 'page_changed', detail,
        observed_page: observed.pageKey, decision_page: entry.pageKey,
        check_ms: check.ms,
      }, { refresh: true })
    }
    const diff = guardDiff(entry.guard, observed.guard)
    if (diff.length > 0) {
      return refuse(summarizeDiff(diff), {
        reason_code: 'semantic_drift',
        what_changed: diff,
        observed: observedSummary(observed.guard),
        decision: observedSummary(entry.guard),
        check_ms: check.ms,
      }, { refresh: true })
    }

    // ── 3. dispatch real input ───────────────────────────────────────────────
    const x = observed.x
    const y = observed.y
    const input = { x, y, calls: [], dispatched: 0 }
    let mode = null
    let verify = null

    if (kind === 'press' && (observed.guard ?? entry.guard) && !EDITABLE_ROLES.has((observed.guard ?? entry.guard).role)) {
      const role = (observed.guard ?? entry.guard).role
      return refuse(`press targets the focused element; ref ${ref} is a ${role} — use click instead or press without ref`, {
        reason_code: 'press_needs_editable', role, check_ms: check.ms,
      })
    }

    if (verifyDelivery) {
      const arm = await call('evaluate', { code: probeArm(entry.node) }, session, { budgetMs: cfg.actInputTimeoutMs })
      if (!arm.ok) debugLog(`act: delivery probe could not be armed (${arm.error?.message ?? 'timeout'}); continuing`)
    }

    if (kind === 'click' || kind === 'press') {
      // A trusted click both performs the action and (for press) focuses the field.
      const click = await dispatchMouseClick(session, x, y)
      input.calls.push(...click.calls)
      input.dispatched += click.dispatched
      if (!click.ok) {
        return finish({
          ok: false, executed: click.dispatched > 0, stale: false,
          no_input_dispatched: click.dispatched === 0,
          partial_input: click.dispatched > 0,
          unknown_effects: click.dispatched > 0,
          timedOut: click.timedOut,
          reason: `input dispatch failed at ${click.failedType}: ${click.error?.message ?? 'unknown error'}`,
          input, check_ms: check.ms,
        })
      }
      mode = 'trusted-click'
    }

    if (kind === 'press') {
      const keyed = await dispatchKey(session, KEYS[args.key])
      input.calls.push(...keyed.calls)
      input.dispatched += keyed.dispatched
      if (!keyed.ok) {
        return finish({
          ok: false, executed: input.dispatched > 0, stale: false, no_input_dispatched: input.dispatched === 0,
          partial_input: true, unknown_effects: true, timedOut: keyed.timedOut,
          reason: `key dispatch failed: ${keyed.calls.find((c) => !c.ok)?.error ?? 'unknown error'}`,
          input, check_ms: check.ms,
        })
      }
      mode = mode === 'trusted-click' ? 'trusted-click+key' : 'key'
    }

    if (kind === 'fill') {
      const click = await dispatchMouseClick(session, x, y)
      input.calls.push(...click.calls)
      input.dispatched += click.dispatched
      if (!click.ok && click.dispatched === 0) {
        return finish({
          ok: false, executed: false, stale: false, no_input_dispatched: true, timedOut: click.timedOut,
          reason: `could not focus the field: ${click.error?.message ?? 'unknown error'}`, input, check_ms: check.ms,
        })
      }
      await call('evaluate', { code: selectAll(entry.node) }, session, { budgetMs: cfg.actInputTimeoutMs })
      const insert = await call('cdp', { method: 'Input.insertText', params: { text: args.text } }, session, { budgetMs: cfg.actInputTimeoutMs })
      input.calls.push({ type: 'Input.insertText', ok: insert.ok, ms: insert.ms, error: insert.error?.message ?? null })
      if (insert.ok) input.dispatched += 1
      mode = 'trusted-click+insertText'
    }

    if (kind === 'select') {
      const applied = await call('evaluate', { code: domSelectOption(entry.node, JSON.stringify(args.value)) }, session, { budgetMs: cfg.actInputTimeoutMs })
      if (!applied.ok) {
        return finish({ ok: false, executed: false, stale: false, no_input_dispatched: true, reason: `select failed: ${applied.error?.message ?? 'unknown error'}`, input, check_ms: check.ms })
      }
      mode = 'dom-select'
      input.calls.push({ type: 'domSelectOption', ok: true, ms: applied.ms, error: null })
    }

    if (settleMs > 0) await sleep(settleMs)

    // ── 4. verify what actually happened ─────────────────────────────────────
    if (kind === 'fill') {
      const read = await call('evaluate', { code: readValue(entry.node) }, session, { budgetMs: cfg.actInputTimeoutMs })
      let current = null
      if (read.ok) {
        try { current = JSON.parse(read.data?.value) } catch { current = null }
      }
      if (!current || current.gone || current.value !== args.text) {
        // Rich editors and framework-controlled inputs ignore insertText; fall back
        // to a value set that fires input/change so the framework notices.
        const applied = await call('evaluate', { code: domSetValue(entry.node, JSON.stringify(args.text)) }, session, { budgetMs: cfg.actInputTimeoutMs })
        input.calls.push({ type: 'domSetValue', ok: applied.ok, ms: applied.ms, error: applied.error?.message ?? null })
        if (settleMs > 0) await sleep(settleMs)
        const again = await call('evaluate', { code: readValue(entry.node) }, session, { budgetMs: cfg.actInputTimeoutMs })
        let after = null
        if (again.ok) { try { after = JSON.parse(again.data?.value) } catch { after = null } }
        verify = { mode: 'dom-fallback', read_back: after?.value ?? null, expected: args.text, matched: after?.value === args.text }
        mode = `${mode}+dom-fallback`
      } else {
        verify = { mode: 'trusted-input', read_back: current.value, expected: args.text, matched: true, focused: current.focused === true }
      }
    }

    if (kind === 'select') {
      const read = await call('evaluate', { code: readValue(entry.node) }, session, { budgetMs: cfg.actInputTimeoutMs })
      let current = null
      if (read.ok) { try { current = JSON.parse(read.data?.value) } catch { current = null } }
      verify = { mode: 'dom-select', read_back: current?.value ?? null, expected: args.value, matched: current?.value === args.value }
    }

    let delivery = null
    if (verifyDelivery && (kind === 'click' || kind === 'press')) {
      const read = await call('evaluate', { code: PROBE_READ }, session, { budgetMs: cfg.actInputTimeoutMs })
      if (read.ok) {
        try { delivery = JSON.parse(read.data?.value) } catch { delivery = null }
      }
      if (delivery && delivery.pageKey && pageKeyChanged(entry.pageKey, delivery.pageKey)) {
        delivery.navigated = true
      }
    }

    const payload = {
      ok: true,
      executed: true,
      stale: false,
      ref,
      kind,
      x,
      y,
      mode,
      input_dispatched: input.dispatched,
      input,
      check_ms: check.ms,
      total_ms: Date.now() - started,
    }
    if (delivery) {
      payload.delivered = delivery.probe ? delivery.probe.fired === true : false
      payload.delivered_trusted = delivery.probe ? delivery.probe.trusted === true : null
      payload.delivered_target_matches = delivery.probe ? delivery.probe.matched === true : false
      payload.delivered_target = delivery.probe?.target ?? null
      if (delivery.navigated) payload.delivered_note = 'page navigated during the action — delivery was read on the new document'
      if (!delivery.probe) payload.delivered_note = payload.delivered_note ?? 'no pointer event observed within the settle window'
    }
    if (verify) {
      payload.verified = verify.matched === true
      payload.verify = verify
      if (!verify.matched) {
        payload.ok = false
        payload.executed = true
        payload.unknown_effects = true
        payload.reason = `input was dispatched but the value did not land (read back ${JSON.stringify(verify.read_back)} instead of ${JSON.stringify(verify.expected)})`
      }
    }
    debugLog(`act session=${session} ${ref} ${kind} ${mode} dispatched=${input.dispatched} delivered=${payload.delivered ?? 'n/a'} verified=${payload.verified ?? 'n/a'} ${payload.total_ms}ms`)
    return payload
  }
}
