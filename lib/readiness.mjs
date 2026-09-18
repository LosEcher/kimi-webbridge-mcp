/**
 * Readiness and identity matching for tab lifecycle decisions.
 *
 * Why this exists: the extension decides "the page is usable" with an exact URL
 * comparison (`tab.url !== requested && tab.url !== requested + '/'`), so any
 * normalisation (http→https, redirect, canonical trailing slash, SPA hash route)
 * makes it wait out its full timeout. Readiness here is: same origin + a path
 * that still belongs to what we asked for + a live document — polled with a
 * client-side budget, never with an unbounded wait.
 *
 * `find_tab` in the extension matches by HOSTNAME only (`bt()`: equal or
 * subdomain), which means a request for `127.0.0.1:8799` can be answered with an
 * unrelated `127.0.0.1:3080` tab. Tab identity decisions in this wrapper
 * therefore never rely on hostname matching alone (see lib/tabs.mjs: the created
 * tab is identified by the tab-id diff, and its URL is asserted).
 */

/** Parse a URL into the parts used for identity decisions. */
export function parseUrl(value) {
  if (typeof value !== 'string' || value.length === 0) return null
  try {
    const u = new URL(value)
    return {
      origin: `${u.protocol}//${u.host}`,
      pathname: u.pathname.replace(/\/+$/, '') || '/',
      hash: u.hash || '',
      search: u.search || '',
      host: u.host,
    }
  } catch {
    return null
  }
}

/**
 * Does `actual` still belong to `requested`?
 *
 * mode 'exact'   — same origin and same path (trailing slash ignored).
 * mode 'prefix'  — same origin and the actual path is the requested path or a
 *                  descendant of it (covers appending a canonical path segment).
 *
 * Query and hash are never required to match: they are rewritten by apps and
 * redirects without changing which document we are on. A *different* hash is
 * reported separately (`hash_mismatch`) so callers can still notice an SPA
 * route change without treating it as a failed load.
 */
export function urlMatches(actual, requested, { mode = 'prefix' } = {}) {
  const a = parseUrl(actual)
  const r = parseUrl(requested)
  if (!a || !r) return false
  if (a.origin !== r.origin) return false
  if (a.pathname === r.pathname) return true
  if (mode === 'exact') return false
  if (r.pathname === '/') return true
  return a.pathname.startsWith(`${r.pathname}/`)
}

/** Compare two URLs for "is this the tab we think it is" assertions. */
export function urlIdentity(actual, requested, options) {
  const a = parseUrl(actual)
  const r = parseUrl(requested)
  if (!a || !r) return { matches: false, reason: 'unparsable url', actual, requested }
  if (a.origin !== r.origin) return { matches: false, reason: `different origin: ${a.origin} ≠ ${r.origin}` }
  const matches = urlMatches(actual, requested, options)
  return {
    matches,
    hash_mismatch: Boolean(r.hash) && a.hash !== r.hash,
    reason: matches ? 'ok' : `different path: ${a.pathname} ≁ ${r.pathname}`,
  }
}

/** A ready document is interactive or complete. */
export function readyStateOk(state) {
  return state === 'interactive' || state === 'complete'
}

/**
 * Poll `probe` until it returns a truthy value, a budget expires, or `signal`
 * aborts. Always resolves — the caller decides what a timeout means.
 *
 * @returns {Promise<{ok: boolean, value: any, waitedMs: number, attempts: number, timedOut: boolean}>}
 */
export async function pollUntil(probe, { timeoutMs = 5000, intervalMs = 120, signal } = {}) {
  const started = Date.now()
  let attempts = 0
  let lastValue
  for (;;) {
    attempts += 1
    if (signal?.aborted) return { ok: false, value: lastValue, waitedMs: Date.now() - started, attempts, timedOut: true }
    try {
      lastValue = await probe()
    } catch (error) {
      lastValue = { error: String(error?.message || error) }
    }
    if (lastValue) return { ok: true, value: lastValue, waitedMs: Date.now() - started, attempts, timedOut: false }
    if (Date.now() - started >= timeoutMs) {
      return { ok: false, value: lastValue, waitedMs: Date.now() - started, attempts, timedOut: true }
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}
