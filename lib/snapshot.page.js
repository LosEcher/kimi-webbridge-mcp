// Page-side atomic observation — ONE Runtime.evaluate, no per-node CDP round trips.
//
// Adapted (MIT) from browser-use/jev-ultrafast `jev_ultrafast/snapshot.js`;
// provenance and the three deliberate deviations are documented in README
// ("obs/act: what was borrowed, what was changed").
//
// Loaded as text by lib/obs.mjs and evaluated in the page. Returns a JSON string
// (single string across the CDP boundary, deterministic serialisation).
//
// Contract:
//   { url, title, w, h, viewport, pageKey, text, textChars, scroll, elements[],
//     activeNode, omittedElements, stats }
//   elements[i].node = code-owned identity from a WeakMap (NOT a position)
//   pageKey          = [timeOrigin, href, innerWidth, innerHeight]  ← freshness only
(() => {
  /*__wb:snapshot*/
  if (!document.body) return JSON.stringify({ error: 'no document.body' })
  const cache = window.__wbObs ||= { ids: new WeakMap(), nodes: new Map(), next: 1 }
  const MAX_ELEMENTS = 300
  const MAX_TEXT = 6000

  const identity = (e) => {
    if (!cache.ids.has(e)) cache.ids.set(e, cache.next++)
    const id = cache.ids.get(e)
    cache.nodes.set(id, e)
    return id
  }
  for (const [id, e] of cache.nodes) if (!e.isConnected) cache.nodes.delete(id)

  const safe = (e) => !['password', 'file', 'hidden'].includes(e.type)
  const visible = (e) => !e.closest('[aria-hidden="true"],[inert]') &&
    e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })

  const name = (e, seen = new Set()) => {
    if (!e || seen.has(e)) return ''
    seen.add(e)
    const referenced = (e.getAttribute('aria-labelledby') || '').split(/\s+/)
      .map((id) => name(document.getElementById(id), seen)).filter(Boolean).join(' ')
    return referenced || e.getAttribute('aria-label') ||
      [...(e.labels || [])].map((l) => name(l, seen)).filter(Boolean).join(' ') ||
      (['button', 'submit', 'reset'].includes(e.type) ? e.value : '') || e.getAttribute('alt') ||
      (e.tagName === 'INPUT' ? '' : [...e.childNodes].map((n) => n.nodeType === 3 ? n.textContent :
        n.nodeType === 1 && n.getAttribute('aria-hidden') !== 'true' ? name(n, seen) : '').join(' ').trim()) ||
      e.getAttribute('title') || e.getAttribute('placeholder') || ''
  }

  const roles = ['button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'menuitemradio',
    'option', 'gridcell', 'combobox', 'textbox', 'searchbox', 'spinbutton']
  const selector = 'a[href],button,input,textarea,select,summary,[contenteditable="true"],' +
    roles.map((role) => '[role="' + role + '"]').join(',')

  const role = (e) => {
    const explicit = e.getAttribute('role')
    if (roles.includes(explicit)) return explicit
    if (e.tagName === 'BUTTON' || e.tagName === 'SUMMARY') return 'button'
    if (e.tagName === 'A') return 'link'
    if (e.tagName === 'SELECT') return 'combobox'
    if (e.tagName === 'TEXTAREA' || e.isContentEditable) return 'textbox'
    if (e.tagName === 'INPUT') {
      if (['checkbox', 'radio'].includes(e.type)) return e.type
      if (['button', 'submit', 'reset', 'image'].includes(e.type)) return 'button'
      if (e.type === 'search') return 'searchbox'
      if (e.type === 'number') return 'spinbutton'
      if (['text', 'email', 'url', 'tel'].includes(e.type)) return 'textbox'
    }
    return null
  }

  // Freshness inputs only: document identity + viewport. NOT scroll, NOT form
  // state (form state lives in the per-node guard, scroll is re-resolved at act).
  cache.pageKey = () => [performance.timeOrigin, location.href, innerWidth, innerHeight]

  // Semantic fingerprint of one node: identity + what it means + local context.
  cache.guard = (e) => {
    if (!e?.isConnected || !visible(e)) return null
    const scope = e.closest('form,dialog,[role="dialog"],article,li,tr,[role="row"]') || e.parentElement
    return {
      node: identity(e),
      role: role(e),
      name: name(e),
      value: e.value ?? null,
      checked: e.checked ?? null,
      selectedIndex: e.selectedIndex ?? null,
      readOnly: e.readOnly ?? null,
      disabled: e.matches(':disabled'),
      ariaDisabled: e.getAttribute('aria-disabled'),
      ariaExpanded: e.getAttribute('aria-expanded'),
      ariaChecked: e.getAttribute('aria-checked'),
      ariaSelected: e.getAttribute('aria-selected'),
      href: e.getAttribute('href'),
      scope: scope?.innerText?.slice(0, MAX_TEXT) || '',
    }
  }

  const candidates = []
  for (const e of document.querySelectorAll(selector)) {
    if (!safe(e) || !visible(e) || e.matches(':disabled') || e.closest('[aria-disabled="true"]')) continue
    const r = e.getBoundingClientRect(), x = r.x + r.width / 2, y = r.y + r.height / 2, rname = role(e)
    if (!rname || r.width <= 0 || r.height <= 0 || x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) continue
    if (rname === 'gridcell' && e.querySelector('button,[role="button"]')) continue
    const base = {
      node: identity(e), role: rname, name: name(e) || rname,
      rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
    }
    for (const key of ['checked', 'selected', 'expanded']) {
      const value = e.getAttribute('aria-' + key)
      if (value !== null) base[key] = value
    }
    if (['checkbox', 'radio'].includes(e.type)) base.checked = String(e.checked)
    if (e.tagName === 'SELECT') {
      for (const o of e.options) {
        if (!o.selected && !o.disabled && !o.closest('optgroup[disabled]'))
          candidates.push({ ...base, kind: 'select', value: o.value, name: base.name + ' → ' + o.label })
      }
    } else {
      const editable = !e.readOnly && e.getAttribute('aria-readonly') !== 'true' &&
        (['textbox', 'searchbox', 'spinbutton'].includes(rname) ||
          (rname === 'combobox' && ['INPUT', 'TEXTAREA'].includes(e.tagName)))
      const value = 'value' in e ? String(e.value) :
        e.isContentEditable || rname === 'combobox' ? e.innerText.trim() : ''
      candidates.push({ ...base, kind: editable ? 'fill' : 'click', value })
    }
  }
  const elements = candidates.slice(0, MAX_ELEMENTS)
  const omittedElements = Math.max(0, candidates.length - elements.length)

  const words = [], walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  const range = document.createRange()
  let textNode, length = 0
  while ((textNode = walker.nextNode()) && length < MAX_TEXT) {
    const value = textNode.textContent.trim(), parent = textNode.parentElement
    if (!value || !parent || parent.closest('script,style,noscript,template') || !visible(parent)) continue
    range.selectNodeContents(textNode)
    const r = range.getBoundingClientRect()
    if (r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth) {
      words.push(value)
      length += value.length
    }
  }

  const guards = {}
  for (const el of elements) if (!(el.node in guards)) guards[el.node] = cache.guard(cache.nodes.get(el.node))
  const activeNode = document.activeElement && cache.ids.has(document.activeElement)
    ? cache.ids.get(document.activeElement) : null

  return JSON.stringify({
    url: location.href,
    title: document.title,
    w: innerWidth,
    h: innerHeight,
    pageKey: cache.pageKey(),
    text: words.join('\n'),
    textChars: length,
    scroll: { y: Math.round(scrollY), height: Math.round(document.documentElement.scrollHeight) },
    hidden: document.hidden === true,
    visibility: document.visibilityState,
    focused: document.hasFocus() === true,
    elements,
    guards,
    activeNode,
    omittedElements,
    stats: { elements: elements.length, guards: Object.keys(guards).length, text_chars: length },
  })
})()
