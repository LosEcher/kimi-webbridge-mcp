/**
 * `verify` — mechanical, independent outcome checking.
 *
 * The point (J6): `DONE` is a claim about the world, so it must be checked against
 * the world. This runs a declarative checklist in ONE page read, mutates nothing,
 * and returns `passed:false` with the exact expectation/actual pair when a check
 * fails. A task whose checks fail is not done, whatever the model just said.
 *
 * Honesty rules:
 *   - a failed check is a SUCCESSFUL verification (`ok:true, passed:false`);
 *   - an unrunnable check (bad spec, bad ref, timeout) is `passed:false` and is
 *     marked `unknown:true` — never silently upgraded to a pass;
 *   - the verdict is written to the ops ledger, so "was this closed out?" is
 *     answerable from disk.
 */
import { readFileSync } from 'node:fs'

const VERIFY_SRC = readFileSync(new URL('./verify.page.js', import.meta.url), 'utf8')

export const VERIFY_SOURCE = VERIFY_SRC

/** Kinds of check, and the ops each accepts (documented in the tool schema too). */
export const CHECK_KINDS = Object.freeze({
  url: ['prefix', 'contains', 'equals', 'regex'],
  text: ['contains', 'absent', 'equals'],
  value: ['equals', 'contains'],
  element: ['present', 'absent'],
  count: ['gte', 'lte', 'eq'],
})

const MAX_CHECKS = 50

/**
 * Validate a checklist without touching the browser.
 * @returns {{error: string, index?: number}|{checks: object[]}}
 */
export function validateChecks(input) {
  if (!Array.isArray(input) || input.length === 0) {
    return { error: 'verify requires checks: a non-empty array of check objects' }
  }
  if (input.length > MAX_CHECKS) {
    return { error: `verify accepts at most ${MAX_CHECKS} checks (got ${input.length})` }
  }
  const checks = []
  for (let i = 0; i < input.length; i += 1) {
    const raw = input[i]
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { error: `check ${i + 1} must be an object`, index: i }
    }
    const kinds = Object.keys(CHECK_KINDS).filter((k) => raw[k] !== undefined)
    if (kinds.length !== 1) {
      return {
        error: `check ${i + 1}${raw.name ? ` (${raw.name})` : ''} must have exactly one of ${Object.keys(CHECK_KINDS).join('/')}`,
        index: i,
      }
    }
    const kind = kinds[0]
    const spec = raw[kind]
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
      return { error: `check ${i + 1}: ${kind} must be an object, e.g. { ${kind}: { op: "${CHECK_KINDS[kind][0]}", value: "…" } }`, index: i }
    }
    if (spec.op !== undefined && !CHECK_KINDS[kind].includes(spec.op)) {
      return { error: `check ${i + 1}: ${kind} op must be one of ${CHECK_KINDS[kind].join('/')}`, index: i }
    }
    if (kind !== 'element' && spec.value === undefined) {
      return { error: `check ${i + 1}: ${kind} needs a value`, index: i }
    }
    // A pathological regex runs INSIDE the page: it would hold the evaluate until
    // the client budget aborts, so keep patterns and expected values small.
    if (kind === 'url' && spec.op === 'regex' && String(spec.value).length > 200) {
      return { error: `check ${i + 1}: url regex is too long (${String(spec.value).length} chars, max 200)`, index: i }
    }
    if (typeof spec.value === 'string' && spec.value.length > 2000) {
      return { error: `check ${i + 1}: value is too long (${spec.value.length} chars, max 2000)`, index: i }
    }
    if (typeof spec.selector === 'string' && spec.selector.length > 500) {
      return { error: `check ${i + 1}: selector is too long (${spec.selector.length} chars, max 500)`, index: i }
    }
    if ((kind === 'value' || kind === 'element') && !spec.ref && !spec.css && !spec.selector) {
      return { error: `check ${i + 1}: ${kind} needs ref (from obs) or css`, index: i }
    }
    checks.push({ name: typeof raw.name === 'string' && raw.name ? raw.name : `check${i + 1}`, [kind]: spec })
  }
  return { checks }
}

/**
 * @param {object} deps
 * @param {Function} deps.call daemon transport
 * @param {object} deps.cfg
 * @param {object} [deps.ledger]
 * @param {object} [deps.guard] session trust guard (same contract as obs/act)
 */
export function createVerifyHandler({ call, cfg, ledger = null, guard = null }) {
  return async function verify(args, session) {
    const started = Date.now()
    if (guard && args.allow_any_tab !== true) {
      const verdict = guard.check(session)
      if (!verdict.allowed) {
        return {
          ok: false, passed: false, unknown: true, reason_code: 'session_unbound',
          reason: verdict.reason, hint: verdict.hint,
        }
      }
    }
    const validated = validateChecks(args.checks)
    if (validated.error) {
      return {
        ok: false, passed: false, unknown: true, reason_code: 'invalid_checks',
        reason: validated.error, index: validated.index ?? null,
        accepted: Object.fromEntries(Object.entries(CHECK_KINDS).map(([k, ops]) => [k, ops])),
      }
    }

    const read = await call('evaluate', { code: `(${VERIFY_SRC})(${JSON.stringify({ checks: validated.checks })})` }, session, { budgetMs: cfg.verifyTimeoutMs })
    if (!read.ok) {
      const reason = read.timedOut
        ? `verification timed out after ${read.budgetMs} ms — the outcome is UNKNOWN, not a pass`
        : `verification could not run: ${read.error?.message ?? 'unknown error'}`
      return { ok: false, passed: false, unknown: true, reason_code: read.timedOut ? 'verify_timeout' : 'verify_failed', reason, round_trips: 1, ms: Date.now() - started }
    }

    const value = read.data?.value
    let result
    if (value && typeof value === 'object') {
      result = value
    } else {
      try {
        result = JSON.parse(value)
      } catch (error) {
        return { ok: false, passed: false, unknown: true, reason_code: 'malformed_result', reason: `verification returned malformed JSON: ${error.message}`, raw: String(value).slice(0, 300) }
      }
    }
    if (result.error || result.ok === false) {
      return { ok: false, passed: false, unknown: true, reason_code: 'page_error', reason: `verification could not run in the page: ${result.error ?? 'unknown'}` }
    }

    const passed = result.passed === true
    if (ledger) ledger.verified({ session, passed, failed: result.failed ?? [], ms: Date.now() - started, url: result.url ?? null })

    const payload = {
      ok: true,
      passed,
      verdict: passed ? 'PASS' : 'FAIL',
      failed: result.failed ?? [],
      checks: result.checks ?? [],
      url: result.url ?? null,
      title: result.title ?? null,
      page_key: result.pageKey ?? null,
      round_trips: 1,
      ms: Date.now() - started,
    }
    if (!passed) {
      payload.hint = 'the task is NOT finished: fix what the failed checks name and re-verify, or report BLOCKED with these checks as evidence. ' +
        'Re-read the page with obs before acting again (a failed check often means the page is not in the state you assumed).'
    }
    if (cfg.debug) {
      process.stderr.write(`[webbridge-mcp] verify ${session} ${payload.verdict} failed=${(payload.failed ?? []).join(',') || '-'} ${payload.ms}ms\n`)
    }
    return payload
  }
}
