/**
 * `obs` — one atomic observation, one page read.
 *
 * Replaces the accessibility-tree snapshot (p50 45.5k chars ≈ 11k tokens, and
 * truncated on real pages) with a compact indexed table plus the freshness
 * material the execution layer needs. The page read is a single
 * `Runtime.evaluate`; no per-node round trips.
 *
 * Keep-alive is applied lazily: if the page reports itself hidden (our tabs are
 * created in the background on purpose), focus emulation is armed once so the
 * tab is not throttled to 1 timer/minute and real input is delivered. A visible
 * page costs exactly one round trip.
 */
import { readFileSync } from 'node:fs'
import { buildObsPayload, DEFAULT_LIMITS } from './payload.mjs'
import { armFocus } from './tabs.mjs'

const SNAPSHOT_SRC = readFileSync(new URL('./snapshot.page.js', import.meta.url), 'utf8')

export const OBS_SNAPSHOT_SOURCE = SNAPSHOT_SRC

/**
 * @param {object} deps
 * @param {Function} deps.call daemon transport
 * @param {object} deps.store observation store
 * @param {object} deps.cfg
 * @param {object} [deps.guard] session guard: refuses to observe a session whose
 *   working tab is not known to be ours (a failed tab-binding call can leave the
 *   session pointing at a tab borrowed from the user).
 */
export function createObsHandler({ call, store, cfg, guard = null }) {
  return async function obs(args, session) {
    const started = Date.now()
    if (guard && args.allow_any_tab !== true) {
      const verdict = guard.check(session)
      if (!verdict.allowed) {
        return {
          ok: false,
          reason_code: 'session_unbound',
          reason: verdict.reason,
          hint: verdict.hint,
          session_state: verdict.state
            ? { bound: verdict.state.bound, url: verdict.state.url, source: verdict.state.source }
            : null,
          stats: { round_trips: 0, reads: 0, ms: Date.now() - started },
        }
      }
    }
    const read = await call('evaluate', { code: SNAPSHOT_SRC }, session, { budgetMs: cfg.obsTimeoutMs })
    if (!read.ok) {
      return {
        ok: false,
        reason: read.timedOut
          ? `observation timed out after ${read.budgetMs} ms`
          : `observation failed: ${read.error?.message ?? 'unknown error'}`,
        error: read.error ?? null,
        timedOut: read.timedOut === true,
        stats: { round_trips: 1, reads: 1, ms: Date.now() - started },
      }
    }
    const value = read.data?.value
    let page
    if (typeof value === 'string') {
      try { page = JSON.parse(value) } catch (error) {
        return { ok: false, reason: `observation returned malformed JSON: ${error.message}`, stats: { round_trips: 1, reads: 1, ms: Date.now() - started } }
      }
    } else if (value && typeof value === 'object') {
      page = value
    } else {
      return { ok: false, reason: `observation returned no page data (${JSON.stringify(value)})`, stats: { round_trips: 1, reads: 1, ms: Date.now() - started } }
    }
    if (page.error) return { ok: false, reason: `page not observable: ${page.error}`, stats: { round_trips: 1, reads: 1, ms: Date.now() - started } }

    let keepAlive = null
    let keepAliveCalls = 0
    if (page.hidden === true && args.keep_alive !== false) {
      keepAlive = await armFocus(call, session)
      keepAliveCalls = 2
    }

    const { generation } = store.begin(session)
    const limits = {
      maxChars: args.max_chars ?? cfg.obsMaxChars ?? DEFAULT_LIMITS.maxChars,
      maxElements: args.max_elements ?? cfg.obsMaxElements ?? DEFAULT_LIMITS.maxElements,
      textChars: args.text_chars ?? cfg.obsTextChars ?? DEFAULT_LIMITS.textChars,
      includeRect: args.include_rect === true,
    }
    const built = buildObsPayload(page, {
      generation,
      ...limits,
      obsMs: read.ms,
      calls: { reads: 1, keepAliveCalls },
    })
    const committed = store.commit(session, generation, built.offered)

    const payload = {
      ok: true,
      ...built.payload,
      stats: {
        ...built.payload.stats,
        ms: Date.now() - started,
        round_trips: 1 + keepAliveCalls,
        evicted_refs: committed.evicted,
      },
    }
    if (keepAlive) payload.keep_alive = keepAlive
    if (payload.truncated) payload.hint = 'payload truncated to the character budget — raise max_chars/max_elements or narrow the page'

    if (cfg.debug) {
      process.stderr.write(`[webbridge-mcp] obs ${session} o${generation} chars=${built.stats.chars} elements=${built.stats.elements_offered}/${built.stats.elements_seen} hidden=${page.hidden === true} ${read.ms}ms\n`)
    }
    return payload
  }
}
