// Page-side precondition check for `act` — ONE Runtime.evaluate that answers, for
// the node the decision named:
//   is it still there, still enabled/visible, where is it NOW (geometry is
//   re-resolved, never trusted from observation time), is that point really
//   hitting it (occlusion), and does it still MEAN the same thing (guard).
//
// Loaded as text by lib/act.mjs and called as `(<this file>)(<node id>)`.
// Returns a JSON string: { ok:false, reason, ...detail } or
//   { ok:true, x, y, pageKey, guard, hit }
// Nothing is dispatched from here: refusing is a pure read.
(node) => {
  /*__wb:check*/
  const cache = window.__wbObs
  const describe = (e) => {
    if (!e) return null
    const label = (e.getAttribute && (e.getAttribute('aria-label') || e.getAttribute('id') ||
      e.getAttribute('name'))) || (e.textContent || '').trim().slice(0, 40)
    return { tag: e.tagName, label: label || null }
  }
  const reply = (value) => JSON.stringify(value)
  if (!cache || !cache.nodes) return reply({ ok: false, reason: 'not observed', detail: 'obs has never run in this tab' })
  const e = cache.nodes.get(node)
  if (!e) return reply({ ok: false, reason: 'node gone', detail: 'the observed node is no longer in the page store' })
  if (!e.isConnected) return reply({ ok: false, reason: 'detached', detail: 'the element was removed from the document' })
  if (e.matches(':disabled') || e.closest('[aria-disabled="true"],[inert]')) {
    return reply({ ok: false, reason: 'disabled', detail: 'the element is disabled or inside an inert subtree' })
  }
  if (!e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) {
    return reply({ ok: false, reason: 'invisible', detail: 'the element is hidden (display/visibility/opacity)' })
  }
  const r = e.getBoundingClientRect()
  if (!r.width || !r.height) return reply({ ok: false, reason: 'no layout box', detail: 'element has zero size' })
  const x = r.x + r.width / 2
  const y = r.y + r.height / 2
  if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) {
    return reply({
      ok: false, reason: 'outside viewport',
      detail: `center (${Math.round(x)}, ${Math.round(y)}) is outside ${innerWidth}x${innerHeight}`,
      point: [Math.round(x), Math.round(y)],
    })
  }
  const hit = document.elementFromPoint(x, y)
  if (!hit || !e.contains(hit)) {
    return reply({
      ok: false, reason: 'covered',
      detail: `point (${Math.round(x)}, ${Math.round(y)}) is covered`,
      by: describe(hit),
      point: [Math.round(x), Math.round(y)],
    })
  }
  return reply({
    ok: true, x, y,
    pageKey: cache.pageKey(),
    guard: cache.guard(e),
    hit: describe(hit),
  })
}
