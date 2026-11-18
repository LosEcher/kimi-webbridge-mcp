// Page-side declarative verification — ONE Runtime.evaluate, ZERO mutation.
//
// `DONE` is a claim, not evidence: this is the mechanical check that decides
// whether a task actually finished. It answers only questions about observable
// page facts (url / text / a control's value / presence / count), so it cannot be
// satisfied by the model restating its own intent.
//
// Loaded as text by lib/verify.mjs and called as `(<this file>)(<payload JSON>)`.
// Returns a JSON string:
//   { ok:true, passed, failed:[names], url, title, pageKey, checks:[{name,kind,ok,expected,actual,error?}] }
// `ok:false` is reserved for "could not even run the checks" (never for a failed
// check — a failed check is a successful verification with passed:false).
//
// Targets:
//   { ref: "o3:17" }  a node identity from the last obs (preferred: it is bound to
//                     the element the decision was about)
//   { css: "..." }    an explicit escape hatch, must match EXACTLY one element
(payload) => {
  /*__wb:verify*/
  const checks = (payload && payload.checks) || []
  const cache = window.__wbObs
  const clip = (value, max = 300) => {
    const text = value === null || value === undefined ? '' : String(value)
    return text.length > max ? `${text.slice(0, max - 1)}…` : text
  }
  const reply = (value) => JSON.stringify(value)

  const resolve = (target) => {
    if (!target || typeof target !== 'object') return { error: 'target must be {ref} or {css}' }
    if (target.ref) {
      const m = /^o(\d+):(\d+)$/.exec(String(target.ref).trim())
      if (!m) return { error: `malformed ref ${JSON.stringify(target.ref)}` }
      const el = cache && cache.nodes ? cache.nodes.get(Number(m[2])) : null
      if (!el) return { error: `ref ${target.ref} is not resolvable (call obs again)` }
      if (!el.isConnected) return { error: `ref ${target.ref} is detached` }
      return { el }
    }
    if (target.css) {
      let list
      try {
        list = document.querySelectorAll(target.css)
      } catch (error) {
        return { error: `bad selector ${JSON.stringify(target.css)}: ${error.message}` }
      }
      if (list.length === 0) return { error: `no element matches ${target.css}` }
      if (list.length > 1) return { error: `${list.length} elements match ${target.css} (expected exactly one)` }
      return { el: list[0] }
    }
    return { error: 'target needs ref or css' }
  }

  const readValue = (el) => {
    if ('value' in el) return String(el.value ?? '')
    if (el.isContentEditable) return String(el.innerText ?? '')
    return String(el.textContent ?? '').trim()
  }

  const compare = (op, actual, expected) => {
    const a = actual === null || actual === undefined ? '' : String(actual)
    const e = expected === null || expected === undefined ? '' : String(expected)
    switch (op) {
      case 'equals': return a === e
      case 'contains': return a.includes(e)
      case 'absent': return !a.includes(e)
      case 'prefix': return a.startsWith(e)
      case 'regex':
        try { return new RegExp(e).test(a) } catch { return false }
      case 'gte': return Number(a) >= Number(e)
      case 'lte': return Number(a) <= Number(e)
      case 'eq': return Number(a) === Number(e)
      default: return false
    }
  }

  const results = []
  for (let i = 0; i < checks.length; i += 1) {
    const check = checks[i] && typeof checks[i] === 'object' ? checks[i] : {}
    const name = typeof check.name === 'string' && check.name ? check.name : `check${i + 1}`
    const kind = ['url', 'text', 'value', 'element', 'count'].find((k) => check[k] && typeof check[k] === 'object')
    if (!kind) {
      results.push({ name, kind: null, ok: false, error: 'check needs exactly one of url/text/value/element/count' })
      continue
    }
    const spec = check[kind]
    const op = typeof spec.op === 'string' ? spec.op : null
    const entry = { name, kind, op, expected: spec.value ?? spec.op ?? null }

    if (kind === 'url') {
      const actual = location.href
      const useOp = op ?? 'prefix'
      entry.actual = clip(actual)
      entry.ok = compare(useOp, actual, spec.value)
      if (!entry.ok) entry.error = `url ${useOp} ${JSON.stringify(clip(spec.value))} did not match ${JSON.stringify(clip(actual))}`
      results.push(entry)
      continue
    }

    if (kind === 'text') {
      const scope = spec.selector
        ? (() => {
            try { return document.querySelector(spec.selector) } catch { return null }
          })()
        : document.body
      if (!scope) {
        entry.ok = false
        entry.error = spec.selector ? `text scope ${spec.selector} not found` : 'no document.body'
        results.push(entry)
        continue
      }
      const actual = String(scope.innerText ?? scope.textContent ?? '')
      const useOp = op ?? 'contains'
      entry.actual = clip(actual)
      entry.actual_chars = actual.length
      entry.ok = compare(useOp, actual, spec.value)
      if (!entry.ok) entry.error = `text ${useOp} ${JSON.stringify(clip(spec.value))} not satisfied`
      results.push(entry)
      continue
    }

    if (kind === 'element') {
      const useOp = op ?? 'present'
      const wantsAbsent = useOp === 'absent'
      if (spec.ref || spec.css) {
        const found = resolve(spec)
        const present = !found.error
        entry.actual = present ? { tag: found.el.tagName, text: clip(found.el.textContent, 80) } : { error: found.error }
        entry.ok = wantsAbsent ? !present : present
        if (!entry.ok) entry.error = wantsAbsent ? `element is present (${found.el?.tagName})` : found.error
      } else if (spec.selector || spec.selector_css) {
        const css = spec.selector ?? spec.selector_css
        let count = 0
        try { count = document.querySelectorAll(css).length } catch (error) { entry.error = `bad selector: ${error.message}` }
        entry.actual = { matches: count }
        entry.ok = wantsAbsent ? count === 0 : count > 0
        if (!entry.ok && !entry.error) entry.error = wantsAbsent ? `${count} element(s) match ${css}` : `no element matches ${css}`
      } else {
        entry.ok = false
        entry.error = 'element check needs ref, css or selector'
      }
      results.push(entry)
      continue
    }

    if (kind === 'count') {
      const css = spec.css ?? spec.selector
      let count = null
      let error = null
      try { count = document.querySelectorAll(css).length } catch (e) { error = `bad selector: ${e.message}` }
      const useOp = op ?? 'gte'
      entry.actual = error ? { error } : { matches: count }
      entry.ok = error ? false : compare(useOp, count, spec.value)
      if (error) entry.error = error
      else if (!entry.ok) entry.error = `count ${count} does not satisfy ${useOp} ${spec.value}`
      results.push(entry)
      continue
    }

    // kind === 'value'
    const useOp = op ?? 'equals'
    const found = resolve(spec)
    if (found.error) {
      entry.ok = false
      entry.error = found.error
      results.push(entry)
      continue
    }
    const actual = readValue(found.el)
    entry.actual = clip(actual)
    entry.ok = compare(useOp, actual, spec.value)
    entry.tag = found.el.tagName
    if (!entry.ok) entry.error = `value is ${JSON.stringify(clip(actual))}, expected ${useOp} ${JSON.stringify(clip(spec.value))}`
    results.push(entry)
  }

  const failed = results.filter((c) => !c.ok).map((c) => c.name)
  return reply({
    ok: true,
    passed: results.length > 0 && failed.length === 0,
    failed,
    url: location.href,
    title: document.title,
    pageKey: cache && cache.pageKey ? cache.pageKey() : null,
    checks: results,
  })
}
