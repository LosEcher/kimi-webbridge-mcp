/**
 * Per-session working-tab trust.
 *
 * A session's "working tab" is whatever the extension last bound. The dangerous
 * state is a session whose working tab is a tab we borrowed from the USER: after
 * a failed tab-binding attempt, that is exactly where the session can be left,
 * and every later obs/act would then read or click on the user's live page.
 * (Measured: an open_tab that failed to adopt its created tab left the session
 * pointing at the user's internal business system, and the next obs happily
 * returned that page's element table.)
 *
 * So tab binding is tracked explicitly:
 *   bind(...)    a call succeeded and we know which tab is working
 *   unbind(...)  a call failed in a way that leaves the working tab unknown or
 *                borrowed-from-the-user
 *   check(...)   obs/act consult this before touching the page
 *
 * `unknown` (no record yet, e.g. the first call after a server restart) is
 * allowed, because the legacy tools (navigate/find_tab/snapshot/click/...) are
 * still supported and the model may legitimately be mid-flow. Only a *known bad*
 * state blocks, and `allow_any_tab: true` is an explicit override.
 */

export function createSessionGuard() {
  /** @type {Map<string, {bound: boolean, url: string|null, source: string, reason?: string, borrowed?: boolean, at: number, anchors: Set<number>}>} */
  const sessions = new Map()

  const stateOf = (session) => {
    let state = sessions.get(session)
    if (!state) {
      state = { bound: false, url: null, source: 'unknown', at: 0, anchors: new Set() }
      sessions.set(session, state)
    }
    return state
  }

  return {
    /** Record a successful tab binding. */
    bind(session, { url = null, source = 'unknown', borrowed = false } = {}) {
      const state = stateOf(session)
      state.bound = true
      state.url = url
      state.source = source
      state.borrowed = borrowed
      state.reason = undefined
      state.at = Date.now()
    },

    /** Record a state where the working tab must not be trusted. */
    unbind(session, { reason, borrowedUrl = null, source = 'unknown' } = {}) {
      const state = stateOf(session)
      state.bound = false
      state.url = borrowedUrl
      state.source = source
      state.reason = reason
      state.at = Date.now()
    },

    /**
     * Remember a tab that belongs to the USER (borrowed as a CDP anchor). Such a
     * tab must never be used as a navigation target or closed.
     */
    markAnchor(session, tabId) {
      if (typeof tabId !== 'number') return
      stateOf(session).anchors.add(tabId)
    },

    isAnchor(session, tabId) {
      const state = sessions.get(session)
      return state ? state.anchors.has(tabId) : false
    },

    /**
     * May obs/act touch this session's page?
     * @returns {{allowed: boolean, reason?: string, hint?: string, state: object|null}}
     */
    check(session) {
      const state = sessions.get(session) ?? null
      if (!state || state.at === 0) return { allowed: true, state: null }
      if (state.bound) return { allowed: true, state }
      return {
        allowed: false,
        state,
        reason: `this session's working tab is not trusted: ${state.reason ?? 'the last tab-binding call failed'}` +
          (state.url ? ` (it may be the borrowed tab ${state.url})` : ''),
        hint: 'bind a tab you own first — call open_tab (it reuses or navigates a session tab), or find_tab for a tab this session opened. ' +
          'If you really mean to operate on whatever tab is current, pass allow_any_tab:true.',
      }
    },

    forget(session) {
      sessions.delete(session)
    },

    /** Diagnostics for tests. */
    state(session) {
      return sessions.get(session) ?? null
    },
  }
}
