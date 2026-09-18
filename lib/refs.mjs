/**
 * Observation references and semantic freshness — the pure core of obs/act.
 *
 * A ref is minted by `obs` and consumed by `act`. It encodes the real DOM node's
 * identity (a WeakMap id held by the page-side snapshot) plus the observation
 * generation that offered it:
 *
 *     o<generation>:<node>        e.g.  o3:17
 *
 * Why identity + generation, and not a positional `@e1`:
 *   a positional ref is reused across snapshots, so using an old ref silently
 *   addresses a DIFFERENT element while every layer reports success. Here an old
 *   ref either still addresses the SAME node (and is accepted only while that
 *   node's meaning is unchanged) or fails loudly (`detached` / `node gone`).
 *
 * Freshness (what may invalidate a decision):
 *   - `pageKey`: navigation identity (timeOrigin, href, viewport size).
 *   - per-node `guard`: identity + role/name/value/state/aria/href + scoped text.
 * Deliberately NOT freshness inputs:
 *   - geometry (re-resolved from scratch at act time — the element may move);
 *   - scroll position (scrolling does not change what an element means).
 * Both exclusions are intentional and covered by tests.
 */

/** `o<gen>:<node>` */
const REF_RE = /^o(\d+):(\d+)$/

/** Guard fields compared for drift, in the order they are reported. */
export const GUARD_FIELDS = Object.freeze([
  'role', 'name', 'value', 'checked', 'selectedIndex', 'readOnly', 'disabled',
  'ariaDisabled', 'ariaExpanded', 'ariaChecked', 'ariaSelected', 'href', 'scope',
])

/** Human-readable labels for the fields above (used in refusal reasons). */
const FIELD_LABEL = Object.freeze({
  role: 'role', name: 'name', value: 'value', checked: 'checked state',
  selectedIndex: 'selected option', readOnly: 'readOnly', disabled: 'disabled',
  ariaDisabled: 'aria-disabled', ariaExpanded: 'aria-expanded', ariaChecked: 'aria-checked',
  ariaSelected: 'aria-selected', href: 'href', scope: 'surrounding text',
})

/** Mint a ref string for a page-side node id inside one observation generation. */
export function mintRef(generation, node) {
  if (!Number.isInteger(generation) || generation < 1) throw new Error(`mintRef: bad generation ${generation}`)
  if (!Number.isInteger(node) || node < 1) throw new Error(`mintRef: bad node ${node}`)
  return `o${generation}:${node}`
}

/** Parse a ref string. Returns `{generation, node}` or `null` when malformed. */
export function parseRef(ref) {
  if (typeof ref !== 'string') return null
  const m = REF_RE.exec(ref.trim())
  if (!m) return null
  const generation = Number(m[1])
  const node = Number(m[2])
  if (generation < 1 || node < 1) return null
  return { generation, node }
}

/** True when a value is a well-formed ref. */
export function isRef(ref) {
  return parseRef(ref) !== null
}

function sameScalar(a, b) {
  return a === b || (a === undefined && b === null) || (a === null && b === undefined)
}

/**
 * Diff a stored guard against a freshly observed one.
 * `scope` (potentially thousands of characters of scoped text) is summarised
 * rather than echoed.
 *
 * @returns {{field: string, from: unknown, to: unknown, chars?: {from: number, to: number}}[]}
 */
export function guardDiff(stored, current) {
  const out = []
  if (!stored || !current) return [{ field: 'node', from: Boolean(stored), to: Boolean(current) }]
  for (const field of GUARD_FIELDS) {
    const a = stored[field]
    const b = current[field]
    if (field === 'scope') {
      if (!sameScalar(a, b) && (a ?? '') !== (b ?? '')) {
        out.push({ field, chars: { from: String(a ?? '').length, to: String(b ?? '').length } })
      }
      continue
    }
    if (!sameScalar(a, b)) out.push({ field, from: a, to: b })
  }
  return out
}

function clip(value, max = 60) {
  const text = value === null || value === undefined ? String(value) : String(value)
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/**
 * Turn a guard diff into an actionable refusal reason.
 * The model must be able to see WHAT changed without a second observation.
 */
export function summarizeDiff(diff) {
  if (diff.length === 0) return 'semantic drift'
  const [first, ...rest] = diff
  const label = FIELD_LABEL[first.field] ?? first.field
  let detail
  if (first.field === 'scope') {
    detail = `${label} changed (${first.chars?.from ?? '?'} → ${first.chars?.to ?? '?'} chars)`
  } else if (first.field === 'node') {
    detail = 'node identity changed'
  } else {
    detail = `${label} ${JSON.stringify(clip(first.from))} → ${JSON.stringify(clip(first.to))}`
  }
  const more = rest.length > 0 ? ` (+${rest.length} more field${rest.length > 1 ? 's' : ''}: ${rest.map((d) => FIELD_LABEL[d.field] ?? d.field).join(', ')})` : ''
  return `semantic drift: ${detail}${more}`
}

/**
 * Page-level change check. Only navigation identity and viewport size are
 * compared — scroll position is intentionally not part of the page key.
 */
export function pageKeyChanged(stored, current) {
  if (!Array.isArray(stored) || !Array.isArray(current)) return false
  // [timeOrigin, href, innerWidth, innerHeight]
  for (const i of [0, 1, 2, 3]) {
    if ((stored[i] ?? null) !== (current[i] ?? null)) return true
  }
  return false
}

/** Explain a page-level change for the refusal payload. */
export function describePageKeyChange(stored, current) {
  if (!Array.isArray(stored) || !Array.isArray(current)) return 'page changed'
  if ((stored[0] ?? null) !== (current[0] ?? null)) return 'page reloaded or navigated (new document)'
  if ((stored[1] ?? null) !== (current[1] ?? null)) return `page navigated: ${clip(stored[1])} → ${clip(current[1])}`
  if ((stored[2] ?? null) !== (current[2] ?? null) || (stored[3] ?? null) !== (current[3] ?? null)) {
    return `viewport resized: ${stored[2]}x${stored[3]} → ${current[2]}x${current[3]}`
  }
  return 'page changed'
}

/**
 * Per-session observation store.
 *
 * Refs are immutable records: `obs` mints them, `act` only reads them. Records
 * from earlier generations are kept (bounded, oldest evicted first) so a ref
 * stays usable as long as the node it names still means the same thing — the
 * guard check, not the ref lifetime, is what protects the action.
 */
export function createObsStore({ maxRefs = 4000 } = {}) {
  /** @type {Map<string, {generation:number, refs:Map<string, object>}>} */
  const sessions = new Map()

  const sessionState = (session) => {
    let state = sessions.get(session)
    if (!state) {
      state = { generation: 0, refs: new Map() }
      sessions.set(session, state)
    }
    return state
  }

  return {
    /** Open a new observation generation (refs are minted against it). */
    begin(session) {
      const state = sessionState(session)
      state.generation += 1
      return { generation: state.generation }
    },

    /**
     * Record the refs a generation offered.
     * @returns {{generation: number, refs: Map<string, object>, evicted: number}}
     */
    commit(session, generation, entries) {
      const state = sessionState(session)
      if (generation !== state.generation) {
        throw new Error(`commit: generation o${generation} is not the current o${state.generation}`)
      }
      const refs = new Map()
      for (const entry of entries) {
        const ref = mintRef(generation, entry.node)
        const record = { ...entry, ref, generation }
        refs.set(ref, record)
        state.refs.set(ref, record)
      }
      let evicted = 0
      while (state.refs.size > maxRefs) {
        const oldest = state.refs.keys().next().value
        state.refs.delete(oldest)
        evicted += 1
      }
      return { generation, refs, evicted }
    },

    /** Convenience: open a generation and record its refs in one step. */
    record(session, entries) {
      const { generation } = this.begin(session)
      return this.commit(session, generation, entries)
    },

    /** Look up a ref minted by an earlier `obs` in this session. */
    get(session, ref) {
      if (parseRef(ref) === null) {
        return { error: `malformed ref ${JSON.stringify(ref)}: expected o<generation>:<node>, e.g. o1:7` }
      }
      const state = sessions.get(session)
      if (!state) return { error: 'no observation in this session yet — call obs first' }
      const found = state.refs.get(ref)
      if (!found) {
        return {
          error: `unknown or expired ref ${ref} (current observation is o${state.generation}) — call obs again`,
          generation: state.generation,
        }
      }
      return { entry: found, generation: state.generation }
    },

    /** Drop a session (used when its tab is closed / session retired). */
    forget(session) {
      sessions.delete(session)
    },

    /** Diagnostics for tests. */
    stats(session) {
      const state = sessions.get(session)
      return state ? { generation: state.generation, refs: state.refs.size } : null
    },
  }
}
