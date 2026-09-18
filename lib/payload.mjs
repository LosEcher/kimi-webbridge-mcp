/**
 * obs payload compaction: the model-facing view.
 *
 * The observation carries two audiences:
 *   - the MODEL, which needs a small indexed table of things it can act on
 *     (default budget 4000 chars — the AX-tree snapshot it replaces measured
 *     p50 45.5k chars ≈ 11k tokens);
 *   - the EXECUTION layer, which needs the freshness inputs (page key + per-node
 *     guards) and never shows them to the model.
 *
 * Truncation is never silent: whatever is dropped is counted in `omitted` and
 * flagged in `truncated`.
 */
import { mintRef } from './refs.mjs'

export const DEFAULT_LIMITS = Object.freeze({
  maxChars: 4000,
  maxElements: 120,
  textChars: 1200,
  includeRect: false,
})

const size = (payload) => JSON.stringify(payload).length

/** Compact one element for the model. */
export function summarizeElement(el, ref, { includeRect = false } = {}) {
  const out = { ref, kind: el.kind, role: el.role, name: el.name }
  if (el.value !== undefined && el.value !== null && el.value !== '') out.value = el.value
  for (const key of ['checked', 'expanded', 'selected']) {
    if (el[key] !== undefined && el[key] !== null) out[key] = el[key]
  }
  if (includeRect && Array.isArray(el.rect)) out.rect = el.rect
  return out
}

/**
 * Build the model-facing payload plus the execution records for the refs that
 * were actually offered.
 *
 * @param {object} page parsed page-side snapshot
 * @param {object} options
 * @param {number} options.generation observation generation (for ref minting)
 * @param {number} [options.maxChars]
 * @param {number} [options.maxElements]
 * @param {number} [options.textChars]
 * @param {boolean} [options.includeRect]
 * @param {number} [options.obsMs] observation cost, reported in stats
 * @param {{reads?: number, keepAliveCalls?: number}} [options.calls]
 */
export function buildObsPayload(page, {
  generation,
  maxChars = DEFAULT_LIMITS.maxChars,
  maxElements = DEFAULT_LIMITS.maxElements,
  textChars = DEFAULT_LIMITS.textChars,
  includeRect = DEFAULT_LIMITS.includeRect,
  obsMs,
  calls = {},
} = {}) {
  const elements = Array.isArray(page.elements) ? page.elements : []
  const guards = page.guards ?? {}
  const fullText = typeof page.text === 'string' ? page.text : ''
  const pageKey = Array.isArray(page.pageKey) ? page.pageKey : null

  const text = fullText.length > textChars ? fullText.slice(0, textChars) : fullText
  const textTruncated = Math.max(0, fullText.length - text.length)

  const offered = []
  const payload = {
    obs: `o${generation}`,
    url: page.url ?? null,
    title: page.title ?? '',
    page: {
      scroll_y: page.scroll?.y ?? 0,
      height: page.scroll?.height ?? 0,
      viewport: `${page.w ?? 0}x${page.h ?? 0}`,
      ...(page.hidden === true ? { hidden: true } : {}),
    },
    text,
    elements: [],
    omitted: { elements: Math.max(0, elements.length - maxElements) + (page.omittedElements ?? 0), text_chars: textTruncated },
    truncated: false,
    stats: { obs_ms: obsMs, reads: calls.reads ?? 1, keep_alive_calls: calls.keepAliveCalls ?? 0 },
  }

  const records = []
  for (const el of elements.slice(0, maxElements)) {
    const guard = guards[el.node] ?? guards[String(el.node)] ?? null
    if (!guard) continue
    records.push({
      node: el.node,
      kind: el.kind,
      role: el.role,
      name: el.name,
      value: el.value ?? null,
      rect: el.rect ?? null,
      guard,
      pageKey,
    })
  }

  // Fit the element table into the character budget, dropping from the END so the
  // model keeps the elements earliest in document order.
  let included = records.length
  const build = () => {
    const list = records.slice(0, included).map((r) => summarizeElement(
      { kind: r.kind, role: r.role, name: r.name, value: r.value, rect: r.rect },
      mintRef(generation, r.node),
      { includeRect },
    ))
    payload.elements = list
    payload.omitted = {
      elements: Math.max(0, elements.length - included) + (page.omittedElements ?? 0),
      text_chars: textTruncated,
    }
    return list
  }
  build()
  while (size(payload) > maxChars && included > 0) {
    const over = size(payload) - maxChars
    // Estimate how many elements to drop: over budget / average element size.
    const avg = Math.max(20, Math.ceil(size(payload) / Math.max(1, included)))
    const drop = Math.max(1, Math.min(included, Math.ceil(over / avg)))
    included -= drop
    build()
  }
  if (size(payload) > maxChars) {
    payload.truncated = true
    const overflow = size(payload) - maxChars
    if (payload.text.length > 0) {
      const keep = Math.max(0, payload.text.length - overflow - 40)
      payload.omitted.text_chars += payload.text.length - keep
      payload.text = payload.text.slice(0, keep)
    }
  }
  for (const record of records.slice(0, included)) {
    offered.push({ ...record, ref: mintRef(generation, record.node), generation })
  }

  return {
    payload,
    offered,
    stats: {
      chars: size(payload),
      elements_offered: offered.length,
      elements_seen: elements.length,
      elements_omitted: payload.omitted.elements,
      text_chars: payload.text.length,
      text_omitted_chars: payload.omitted.text_chars,
      truncated: payload.truncated,
    },
  }
}
