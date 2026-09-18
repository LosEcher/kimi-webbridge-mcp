/**
 * Tab lifecycle for the wrapper: reuse, in-tab navigation, readiness polling and
 * background keep-alive — none of which depend on `navigate`.
 *
 * Why the methods are ordered the way they are (all measured on the real browser,
 * 2026-09-18):
 *
 *   navigate (extension)  its load callback can never arrive on some browsers —
 *                         a 30 s timer wrapping a 300 s CDP call. Measured: p50
 *                         24 s, and an unbounded hang that never even creates the
 *                         tab. Never on the critical path here.
 *
 *   create (cdp)          `Target.createTarget` creates the tab in milliseconds,
 *                         but the extension has NO deterministic way to bind it to
 *                         the session: `cdp` is a blind passthrough and adoption
 *                         happens only through `chrome.tabs.onCreated` ->
 *                         `/internal/tab-adopted`, which fires only when Chrome
 *                         stamps `openerTabId`. Measured adoption rate: 1/3–2/3,
 *                         and an unadopted tab is an ORPHAN that no exposed API
 *                         can list or close. So creation is a single last-resort
 *                         attempt, never retried, and reported honestly.
 *
 *   reuse                a tab this session already owns, matched by URL: binds
 *                         deterministically through the session-tab path.
 *   navigate_in_tab      `cdp Page.navigate` inside a session-owned tab, with our
 *                         own readiness polling (readyState + URL): zero new tabs,
 *                         zero focus change, fully reliable. This is the workhorse.
 *   borrow_matching      the URL the caller wants is the tab the user already has
 *                         in front: borrow it (read-only) instead of creating.
 *
 * Invariants enforced here so this module cannot repeat the bugs it exists to fix:
 *   1. a bound tab is identified by TAB-ID, never by hostname matching (the
 *      extension's `find_tab` matches hostnames, which silently picks a same-host
 *      tab: a request for 127.0.0.1:8799 was answered with 127.0.0.1:3080);
 *   2. the user's foreground tab is never navigated, grouped, brought forward or
 *      closed — at most borrowed read-only as a CDP anchor;
 *   3. a failed create never leaves the session trusted: the caller is told, and
 *      the session guard is marked unbound so obs/act refuse.
 */
import { execFileSync } from 'node:child_process'
import { pollUntil, readyStateOk, urlIdentity, urlMatches } from './readiness.mjs'

const BROWSER_SCRIPTS = [
  ['Vivaldi', 'tell application "Vivaldi" to get URL of active tab of window 1'],
  ['Google Chrome', 'tell application "Google Chrome" to get URL of active tab of window 1'],
  ['Microsoft Edge', 'tell application "Microsoft Edge" to get URL of active tab of window 1'],
  ['Brave Browser', 'tell application "Brave Browser" to get URL of active tab of window 1'],
  ['Chromium', 'tell application "Chromium" to get URL of active tab of window 1'],
]

/**
 * macOS-only helper: read the URL of the tab the user is currently looking at.
 * Used only as a last-resort anchor when the session owns no tab at all. Read
 * only — nothing is navigated, focused or closed.
 */
export function discoverUserTab({ timeoutMs = 4000 } = {}) {
  if (process.platform !== 'darwin') return null
  for (const [app, script] of BROWSER_SCRIPTS) {
    try {
      const url = execFileSync('osascript', ['-e', script], { encoding: 'utf8', timeout: timeoutMs }).trim()
      if (url) return { via: app, url }
    } catch { /* try the next browser */ }
  }
  return null
}

/** List the session's tabs. */
export async function listTabs(call, session) {
  const res = await call('list_tabs', {}, session)
  if (!res.ok) return { ok: false, error: res.error, res }
  return { ok: true, tabs: Array.isArray(res.data?.tabs) ? res.data.tabs : [], res }
}

/** Read the working tab's URL (and readiness) in one round trip. */
export async function probeWorkingTab(call, session) {
  const res = await call('evaluate', { code: `document.readyState + "|" + location.href` }, session)
  if (!res.ok) return { ok: false, error: res.error, res }
  const value = res.data?.value
  if (typeof value !== 'string' || !value.includes('|')) {
    return { ok: false, error: { code: 'probe_shape', message: `unexpected probe value: ${JSON.stringify(value)}` }, res }
  }
  const [readyState, ...rest] = value.split('|')
  return { ok: true, readyState, url: rest.join('|'), ms: res.ms }
}

/**
 * Arm keep-alive on the working tab: make the page believe it is focused and
 * active so a background tab is not throttled (rAF measured 0/s → 120/s) and real
 * input is delivered. `Page.bringToFront` is deliberately NOT used — it would
 * switch the tab the user is looking at.
 */
export async function armFocus(call, session, { lifecycle = true } = {}) {
  const focus = await call('cdp', { method: 'Emulation.setFocusEmulationEnabled', params: { enabled: true } }, session)
  const out = {
    focus_emulation: focus.ok ? 'ok' : `failed: ${focus.error?.message ?? 'unknown'}`,
    focus_emulation_ms: focus.ms,
  }
  if (lifecycle) {
    const state = await call('cdp', { method: 'Page.setWebLifecycleState', params: { state: 'active' } }, session)
    out.web_lifecycle = state.ok ? 'ok' : `skipped: ${state.error?.message ?? 'unknown'}`
  }
  return out
}

async function adoptCreatedTab(call, session, { url, tabIdsBefore, timeoutMs = 3000, debug }) {
  const seen = new Set(tabIdsBefore)
  const poll = await pollUntil(async () => {
    const listed = await listTabs(call, session)
    if (!listed.ok) return null
    const fresh = listed.tabs.filter((t) => !seen.has(t.tabId))
    if (fresh.length === 0) return null
    return { tab: fresh[fresh.length - 1], tabs: listed.tabs }
  }, { timeoutMs, intervalMs: 120 })

  if (!poll.ok || !poll.value) {
    return {
      adopted: false,
      reason: `created tab did not appear in the session within ${timeoutMs} ms`,
      attempts: poll.attempts,
    }
  }
  const { tab } = poll.value
  const identity = urlIdentity(tab.url, url, { mode: 'prefix' })
  if (!identity.matches) {
    // The browser created *something*; we will not operate on a tab we cannot
    // identify. Report instead of guessing.
    return {
      adopted: false,
      wrongUrl: tab.url,
      reason: `created tab has an unexpected url (${identity.reason})`,
      tabId: tab.tabId,
      attempts: poll.attempts,
    }
  }
  const found = await call('find_tab', { url: tab.url, active: false }, session)
  if (!found.ok) {
    return { adopted: false, reason: `find_tab on the created tab failed: ${found.error?.message ?? 'unknown'}`, tabId: tab.tabId }
  }
  const boundTabId = found.data?.tabId
  if (boundTabId !== tab.tabId) {
    return {
      adopted: false,
      reason: `find_tab bound tab ${boundTabId} instead of the created tab ${tab.tabId} — refusing to act on an unverified tab`,
      tabId: tab.tabId,
      boundTabId,
    }
  }
  if (debug) process.stderr.write(`[webbridge-mcp] adopted created tab ${tab.tabId} ${tab.url}\n`)
  return { adopted: true, tabId: tab.tabId, url: tab.url, attempts: poll.attempts }
}

async function waitReady(call, session, { url, timeoutMs = 5000, intervalMs = 120 }) {
  const poll = await pollUntil(async () => {
    const probe = await probeWorkingTab(call, session)
    if (!probe.ok) return null
    if (!readyStateOk(probe.readyState)) return null
    if (!urlMatches(probe.url, url, { mode: 'prefix' })) return null
    return probe
  }, { timeoutMs, intervalMs })
  if (!poll.ok || !poll.value) {
    const last = await probeWorkingTab(call, session)
    return {
      ready: false,
      timedOut: true,
      waitedMs: poll.waitedMs,
      attempts: poll.attempts,
      readyState: last.ok ? last.readyState : null,
      url: last.ok ? last.url : null,
    }
  }
  return {
    ready: true,
    timedOut: false,
    waitedMs: poll.waitedMs,
    attempts: poll.attempts,
    readyState: poll.value.readyState,
    url: poll.value.url,
  }
}

/**
 * Ensure the session has a usable working tab showing `url`.
 *
 * Preference order (see the module header for the measurements behind it):
 *   reuse            a session tab already at the URL  — deterministic
 *   navigate_in_tab  cdp Page.navigate inside a session-owned tab + our own
 *                    readiness polling — deterministic, no new tab, no focus change
 *   borrow_matching  the tab the user has in front IS the requested URL — borrow
 *                    it read-only (never closed)
 *   create           ONE last-resort background create; may fail, never retried,
 *                    and the session is left UNTRUSTED on failure
 *
 * @param {object} guard optional session guard (lib/sessions.mjs): tab binding is
 *   recorded so obs/act refuse to touch a session whose working tab is unknown or
 *   borrowed from the user.
 */
export async function openTab(call, session, {
  url,
  reuse = true,
  canCreate = true,
  readyTimeoutMs = 5000,
  adoptTimeoutMs = 1500,
  navigateTimeoutMs = 10000,
  anchorUrl,
  userTabProbe = discoverUserTab,
  guard = null,
  debug = false,
} = {}) {
  const started = Date.now()
  const withTiming = (record) => ({ ...record, total_ms: Date.now() - started })
  if (!urlMatches(url, url)) return withTiming({ ok: false, reason: `invalid url: ${JSON.stringify(url)}` })

  /** A tab we own is bound and trusted as the working tab. */
  const boundOk = (record) => {
    if (guard) guard.bind(session, { url: record.url ?? url, source: `open_tab:${record.method}`, borrowed: record.borrowed === true })
    return withTiming({ ...record, session_bound: true, ok: record.ready !== false, ...(record.ready === false ? { reason: record.reason ?? `tab did not become ready (${record.ready_state ?? 'unknown'})` } : {}) })
  }
  /** A failure that leaves the working tab unknown or belonging to the user. */
  const untrusted = (record) => {
    if (guard) guard.unbind(session, { reason: record.reason, borrowedUrl: record.borrowed_url ?? null, source: 'open_tab' })
    return withTiming({ ...record, ok: false, session_bound: false })
  }

  const before = await listTabs(call, session)
  if (!before.ok) return withTiming({ ok: false, reason: `list_tabs failed: ${before.error?.message ?? 'unknown'}`, error: before.error })

  /** Tabs the user owns (borrowed as anchors) must never be navigated or closed. */
  const isUserTab = (tab) => tab.borrowed === true || (guard ? guard.isAnchor(session, tab.tabId) === true : false)
  const ownedTabs = before.tabs.filter((t) => !isUserTab(t))

  // ── 1. reuse a session tab already at the URL ─────────────────────────────
  if (reuse) {
    const match = before.tabs.find((t) => urlIdentity(t.url, url, { mode: 'prefix' }).matches)
    if (match) {
      const bound = await call('find_tab', { url: match.url, active: false }, session)
      if (bound.ok && bound.data?.tabId === match.tabId) {
        const focus = await armFocus(call, session)
        const ready = await waitReady(call, session, { url, timeoutMs: readyTimeoutMs })
        return boundOk({
          method: 'reuse', tabId: match.tabId, url: ready.url ?? match.url,
          requested_url: url, owned: !isUserTab(match), borrowed: isUserTab(match), reused: true,
          ready: ready.ready, ready_state: ready.readyState, ready_timed_out: ready.timedOut,
          waited_ms: ready.waitedMs, keep_alive: focus,
        })
      }
      if (debug) process.stderr.write(`[webbridge-mcp] open_tab: reuse bind failed (${bound.error?.message ?? 'tab id mismatch'}) — falling through\n`)
    }
  }

  // ── 2. navigate inside a tab this session already owns ───────────────────
  if (ownedTabs.length > 0) {
    const target = ownedTabs[0]
    const bound = await call('find_tab', { url: target.url, active: false }, session)
    const identified = bound.ok && bound.data?.tabId === target.tabId
    const probe = identified ? await probeWorkingTab(call, session) : null
    const identityOk = probe?.ok === true && urlIdentity(probe.url, target.url, { mode: 'exact' }).matches
    if (!identified || !identityOk) {
      return untrusted({
        method: 'navigate_in_tab', tabId: target.tabId,
        reason: identified
          ? `cannot confirm the working tab is the session tab we bound (found ${probe?.url ?? 'nothing'})`
          : `find_tab could not bind session tab ${target.tabId}`,
        bound_tab_id: bound.data?.tabId ?? null, working_url: probe?.url ?? null,
        hint: 'the session\'s working tab is not identifiable; re-read list_tabs and try again',
      })
    }
    const nav = await call('cdp', { method: 'Page.navigate', params: { url } }, session, { budgetMs: navigateTimeoutMs })
    if (!nav.ok) {
      // The tab is still ours and still bound: the navigation itself failed.
      if (guard) guard.bind(session, { url: target.url, source: 'open_tab:navigate_in_tab(failed)' })
      return withTiming({
        ok: false, session_bound: true, method: 'navigate_in_tab', tabId: target.tabId, from_url: target.url,
        reason: `Page.navigate failed: ${nav.error?.message ?? 'unknown'}`, timedOut: nav.timedOut === true, cdp_ms: nav.ms,
      })
    }
    const focus = await armFocus(call, session)
    const ready = await waitReady(call, session, { url, timeoutMs: readyTimeoutMs })
    return boundOk({
      method: 'navigate_in_tab', tabId: target.tabId, from_url: target.url,
      url: ready.url ?? url, requested_url: url, owned: true, new_tab: false,
      ready: ready.ready, ready_state: ready.readyState, ready_timed_out: ready.timedOut,
      waited_ms: ready.waitedMs, cdp_ms: nav.ms, keep_alive: focus,
    })
  }

  // ── 3. the user already has the requested page in front: borrow it ───────
  const discovered = anchorUrl ? { via: 'param', url: anchorUrl } : userTabProbe()
  if (discovered && urlIdentity(discovered.url, url, { mode: 'prefix' }).matches) {
    const bound = await call('find_tab', { url: discovered.url, active: true }, session)
    if (bound.ok) {
      if (guard) guard.markAnchor(session, bound.data?.tabId)
      const focus = await armFocus(call, session)
      const ready = await waitReady(call, session, { url, timeoutMs: readyTimeoutMs })
      return boundOk({
        method: 'borrow_matching', tabId: bound.data?.tabId, url: bound.data?.url ?? discovered.url,
        requested_url: url, owned: false, borrowed: true, do_not_close: true, anchor: { via: discovered.via, url: discovered.url },
        ready: ready.ready, ready_state: ready.readyState, ready_timed_out: ready.timedOut,
        waited_ms: ready.waitedMs, keep_alive: focus,
        note: 'this tab belongs to the user: it is borrowed read-only and will never be closed by this wrapper',
      })
    }
  }

  // ── 4. last resort: ONE background create (adoption is not guaranteed) ───
  if (!canCreate) {
    return withTiming({
      ok: false, method: 'create', reason: 'the session owns no tab and creation is disabled (can_create:false)',
      anchor: discovered ?? null,
      hint: 'open the URL yourself and call open_tab again (it will borrow that tab), or pass can_create:true',
    })
  }
  const anchorBound = discovered ? await call('find_tab', { url: discovered.url, active: true }, session) : null
  if (!discovered || !anchorBound?.ok) {
    return withTiming({
      ok: false, method: 'create', session_bound: false,
      reason: 'no anchor tab: this session owns no tab and no foreground tab could be borrowed',
      anchor: discovered ?? null,
      hint: 'open any page in the browser, or pass anchor, or open the URL you want (it will then be borrowed); cdp needs an attached tab',
    })
  }
  const anchor = { via: discovered.via, url: anchorBound.data?.url ?? discovered.url, borrowed: true, tabId: anchorBound.data?.tabId ?? null }
  if (guard) guard.markAnchor(session, anchor.tabId)
  // From here on the session's working tab is the USER'S tab until we bind our own.
  if (guard) guard.unbind(session, { reason: 'borrowed a user tab as the CDP anchor; no tab of our own is bound yet', borrowedUrl: anchor.url, source: 'open_tab:anchor' })

  const justBefore = await listTabs(call, session)
  const tabIdsBefore = justBefore.ok ? justBefore.tabs.map((t) => t.tabId) : before.tabs.map((t) => t.tabId)
  const created = await call('cdp', { method: 'Target.createTarget', params: { url, background: true } }, session)
  if (!created.ok) {
    return untrusted({
      method: 'create', created: false, anchor, borrowed_url: anchor.url,
      reason: `Target.createTarget failed: ${created.error?.message ?? 'unknown'}`, timedOut: created.timedOut === true,
    })
  }
  const targetId = created.data?.targetId ?? null
  const adopt = await adoptCreatedTab(call, session, { url, tabIdsBefore, timeoutMs: adoptTimeoutMs, debug })
  if (!adopt.adopted) {
    return untrusted({
      method: 'create', created: true, adopted: false, targetId, anchor, borrowed_url: anchor.url,
      reason: adopt.reason, wrong_url: adopt.wrongUrl, tab_id: adopt.tabId,
      orphan_warning: true,
      hint: 'the browser created a tab but this extension cannot bind it (adoption depends on Chrome setting openerTabId, measured 1/3-2/3), ' +
        'so it may be left open in the browser as an orphan — close it manually. The session is marked untrusted until a tab is bound: ' +
        'retry open_tab, or open the URL yourself and call open_tab again so it is borrowed instead.',
      create_ms: created.ms,
    })
  }
  const focus = await armFocus(call, session)
  const ready = await waitReady(call, session, { url, timeoutMs: readyTimeoutMs })
  return boundOk({
    method: 'create', tabId: adopt.tabId, targetId, anchor, owned: true, new_tab: true, background: true,
    url: ready.url ?? adopt.url, requested_url: url,
    ready: ready.ready, ready_state: ready.readyState, ready_timed_out: ready.timedOut,
    waited_ms: ready.waitedMs, adopt_attempts: adopt.attempts, create_ms: created.ms, keep_alive: focus,
  })
}
