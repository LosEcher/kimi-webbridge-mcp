/**
 * Ops ledger — an append-only JSONL trail of every mutating `act`, plus the
 * `verify` verdicts that close a task out.
 *
 * Two problems it solves, both of which the two backends this wrapper replaces
 * get wrong:
 *
 *   1. "The tool call timed out — so it didn't happen." It may well have
 *      happened (`Input.insertText` landed, the click was delivered, the request
 *      went out) and a blind retry duplicates the write. Measured on this
 *      machine: an `ego-browser` page.evaluate reported `PageEvaluationTimeoutError`
 *      while the record had already been written.
 *   2. "What has the agent already touched in this session?" After an
 *      interruption the answer must be recoverable from disk, not from the
 *      model's memory of its own turns.
 *
 * The rule (J5): a mutation whose outcome is UNKNOWN must not be re-dispatched
 * against the SAME ref. A fresh `obs` mints a new ref (`o<gen+1>:<node>`) — a new
 * decision against a re-read page — and that is the sanctioned retry path. An
 * explicit `retry:true` is the escape hatch, and it is recorded as such.
 *
 * The index is derived from the same events that go to disk, so the refusal rule
 * is unit-testable without touching the filesystem.
 *
 * Two consequences worth knowing:
 *   - Ref strings restart at `o1:<node>` in a new process. A hydrated UNKNOWN
 *     entry can therefore block the first `o1:` ref after a restart. That is
 *     deliberate: a crash is exactly when a duplicate write is most likely, and
 *     the block clears with one fresh `obs` (which mints `o2:`).
 *   - Several MCP servers may append to the same file. Appends are single
 *     `O_APPEND` writes (atomic for lines of this size); the size-based rotation
 *     is best-effort — worst case a few events land in the `.1` generation
 *     instead of the current file. Nothing here may ever fail an action.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs'
import { dirname } from 'node:path'

/** Phases a mutating act goes through. */
export const PHASES = Object.freeze(['intent', 'outcome', 'refused', 'verify'])

let counter = 0
const nextId = (now) => `${now.toString(36)}-${(counter += 1).toString(36)}`

/**
 * In-memory index. `record()` is the only writer; every query derives from the
 * recorded events.
 *
 * @param {object} [options]
 * @param {Function} [options.now] clock (tests)
 * @param {number} [options.maxEntries] ring size for the in-memory history
 */
export function createLedgerIndex({ now = Date.now, maxEntries = 5000 } = {}) {
  /** @type {object[]} */
  const events = []
  /** @type {Map<string, object>} latest "outcome"-bearing event per session|ref */
  const latest = new Map()

  const keyOf = (session, ref) => `${session}\u0000${ref}`

  return {
    /**
     * @param {object} entry
     * @param {string} entry.session
     * @param {string} entry.phase one of PHASES
     * @param {string} [entry.op] 'act' | 'verify'
     * @param {string} [entry.ref]
     * @param {number} [entry.generation]
     * @param {string} [entry.kind]
     * @param {string} [entry.verdict] 'ok' | 'refused' | 'unknown' | 'failed' | 'pass' | 'fail'
     * @param {boolean} [entry.unknown_effects]
     * @param {string} [entry.reason]
     * @param {string} [entry.reason_code]
     * @param {number} [entry.ms]
     */
    record(entry) {
      const event = { ts: now(), id: nextId(now()), ...entry }
      events.push(event)
      while (events.length > maxEntries) events.shift()
      // Only an OUTCOME resolves (or re-opens) a ref's state. A refusal dispatched
      // nothing, so it must not clear an earlier UNKNOWN outcome — otherwise the
      // act that refuses would itself lift the duplicate-dispatch gate.
      if (entry.ref && entry.phase === 'outcome') {
        latest.set(keyOf(entry.session, entry.ref), event)
      }
      return event
    },

    /**
     * The unresolved mutation for a ref, if any: its last outcome left the
     * effect UNKNOWN (partial input, timeout, "value did not land").
     *
     * @returns {object|null}
     */
    unresolved(session, ref) {
      const event = latest.get(keyOf(session, ref))
      if (!event) return null
      return event.unknown_effects === true ? event : null
    },

    /** Recent events for a session, newest last. */
    entries(session, limit = 20) {
      const out = events.filter((e) => e.session === session)
      return out.slice(Math.max(0, out.length - limit))
    },

    /** Every unresolved mutation in a session (for the `ledger` tool). */
    unresolvedAll(session) {
      const out = []
      for (const [key, event] of latest) {
        if (!key.startsWith(`${session}\u0000`)) continue
        if (event.unknown_effects === true) out.push(event)
      }
      return out
    },

    stats() {
      return { events: events.length, tracked_refs: latest.size }
    },

    /** Test/restart helper: rebuild the index from raw events. */
    hydrate(list) {
      for (const event of list) {
        events.push(event)
        if (event.ref && event.phase === 'outcome') latest.set(keyOf(event.session, event.ref), event)
      }
      while (events.length > maxEntries) events.shift()
      return events.length
    },
  }
}

/**
 * Disk-backed ledger. Writes are best-effort on purpose: a ledger that is full,
 * read-only or on a broken volume must never turn a working browser action into
 * a failure. Failures are reported on stderr once per process.
 *
 * Rotation is by size (single `.1` generation): the ledger is an audit trail for
 * "the last hours of work", not an archive.
 */
export function createOpsLedger({ path = null, maxBytes = 8 * 1024 * 1024, debug = false, hydrateBytes = 2 * 1024 * 1024 } = {}) {
  const index = createLedgerIndex()
  let warned = false
  let hydrated = 0

  if (path && existsSync(path)) {
    try {
      const size = statSync(path).size
      const raw = readFileSync(path, 'utf8')
      const text = size > hydrateBytes ? raw.slice(-hydrateBytes) : raw
      const lines = text.split('\n').filter(Boolean)
      // The first line may be a partial record when we tailed by bytes.
      const parsed = []
      for (const line of lines) {
        try { parsed.push(JSON.parse(line)) } catch { /* partial or torn line */ }
      }
      hydrated = index.hydrate(parsed)
    } catch (error) {
      process.stderr.write(`[webbridge-mcp] ledger: cannot read ${path}: ${error.message}\n`)
    }
  }

  function persist(event) {
    if (!path) return
    try {
      mkdirSync(dirname(path), { recursive: true })
      if (existsSync(path) && statSync(path).size > maxBytes) renameSync(path, `${path}.1`)
      appendFileSync(path, `${JSON.stringify(event)}\n`)
    } catch (error) {
      if (!warned) {
        warned = true
        process.stderr.write(`[webbridge-mcp] ledger: cannot append to ${path}: ${error.message} (continuing in memory)\n`)
      }
    }
  }

  function write(entry) {
    const event = index.record(entry)
    persist(event)
    if (debug) {
      process.stderr.write(`[webbridge-mcp] ledger ${event.phase} ${event.session} ${event.ref ?? '-'} ${event.verdict ?? ''} ${event.reason_code ?? ''}\n`)
    }
    return event
  }

  return {
    path,
    hydrated_events: hydrated,

    /** Record the intent to mutate, before anything is dispatched. */
    begin({ session, op = 'act', ref, generation = null, kind = null, args_digest = null }) {
      return write({ session, phase: 'intent', op, ref, generation, kind, args_digest, verdict: 'pending', unknown_effects: false })
    },

    /** Close an intent with what actually happened. */
    finish(id, { session, op = 'act', ref, generation = null, kind = null, verdict, unknown_effects = false, reason = null, reason_code = null, ms = null, evidence = null }) {
      return write({ session, phase: 'outcome', op, id_of_intent: id, ref, generation, kind, verdict, unknown_effects, reason, reason_code, ms, evidence })
    },

    /** A refusal / precondition failure: nothing was dispatched. */
    refused({ session, op = 'act', ref, kind = null, reason, reason_code = null, ms = null }) {
      return write({ session, phase: 'refused', op, ref, kind, verdict: 'refused', unknown_effects: false, reason, reason_code, ms })
    },

    /** A verification verdict ("DONE" is checked, not asserted). */
    verified({ session, passed, failed = [], ms = null, url = null }) {
      return write({
        session, phase: 'verify', op: 'verify', verdict: passed ? 'pass' : 'fail',
        unknown_effects: false, reason: passed ? null : `failed checks: ${failed.join(', ')}`,
        ms, evidence: { failed, url },
      })
    },

    unresolved: index.unresolved,
    unresolvedAll: index.unresolvedAll,
    entries: index.entries,
    stats: index.stats,
  }
}
