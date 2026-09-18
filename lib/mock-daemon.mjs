/**
 * Mock daemon (WEBBRIDGE_MCP_MOCK=1) — a stateful fake page + fake daemon so the
 * whole obs → act → refuse/execute flow is exercisable in CI with no browser.
 * Shared by server.mjs (mock mode) and the unit tests.
 *
 * Test-only control channel: evaluate { code: "mock:<command>" } with one of
 * state | rename | detach | shift | cover | uncover | disable | clear-clicks |
 * hide | show.
 */
import { createMockPage } from './mock-page.mjs'

// ── Mock daemon (WEBBRIDGE_MCP_MOCK=1) ──────────────────────────────────────
// A stateful fake page + fake daemon, so the whole obs → act → refuse/execute
// flow is exercised in CI with no browser. Test-only control channel:
// evaluate { code: "mock:<command>" }.

export function createMockCall() {
  const sessions = new Map()
  const sessionState = (session) => {
    let state = sessions.get(session)
    if (!state) {
      state = { page: createMockPage(), tabs: [], workingTabId: null, nextTabId: 1 }
      sessions.set(session, state)
    }
    return state
  }
  const working = (state) => state.tabs.find((t) => t.tabId === state.workingTabId) ?? null

  return (action, args, session) => {
    const state = sessionState(session ?? 'mock')
    switch (action) {
      case 'evaluate': {
        if (typeof args.code === 'string' && args.code.includes('document.readyState') &&
            !args.code.includes('__wb:')) {
          const tab = working(state)
          return { type: 'string', value: `complete|${tab ? tab.url : state.page.state.url}` }
        }
        return state.page.evaluate(args.code)
      }
      case 'cdp': {
        if (args.method === 'Page.navigate') {
          const tab = working(state)
          if (!tab) return { __error: 'Page.navigate: session has no tab' }
          tab.url = args.params?.url
          return { frameId: 'mock-frame' }
        }
        if (args.method === 'Target.createTarget') {
          const tabId = state.nextTabId++
          state.tabs.push({
            tabId, url: args.params?.url, title: 'Mock', raw: 'createTarget',
            background: args.params?.background === true,
          })
          return { targetId: `mock-target-${tabId}` }
        }
        return state.page.cdp(args.method, args.params ?? {})
      }
      case 'list_tabs':
        return {
          success: true,
          tabs: state.tabs.map((t) => ({
            tabId: t.tabId, url: t.url, title: t.title ?? 'Mock',
            active: t.tabId === state.workingTabId,
            borrowed: t.userOwned === true,
          })),
        }
      case 'find_tab': {
        let tab = state.tabs.find((t) => t.url === args.url)
        if (!tab && args.active) {
          // Emulate the extension borrowing the tab the user is viewing: it is
          // not in the session yet, so it gets added on borrow (and marked as the
          // user's, which is what the real extension reports as borrowed).
          tab = { tabId: state.nextTabId++, url: args.url, title: 'Mock borrowed', raw: 'borrow', userOwned: true }
          state.tabs.push(tab)
        }
        if (!tab) return { __error: `find_tab: no tab matching ${args.url} in this session` }
        state.workingTabId = tab.tabId
        return { success: true, url: tab.url, tabId: tab.tabId, borrowed: Boolean(args.active) }
      }
      case 'navigate': {
        if (args.newTab || state.tabs.length === 0) {
          const tabId = state.nextTabId++
          state.tabs.push({ tabId, url: args.url, title: 'Mock', raw: 'navigate' })
          state.workingTabId = tabId
        } else {
          const tab = working(state)
          tab.url = args.url
        }
        return { success: true, url: args.url, tabId: state.workingTabId }
      }
      case 'close_tab': {
        const index = state.tabs.findIndex((t) => t.tabId === state.workingTabId)
        if (index >= 0) state.tabs.splice(index, 1)
        state.workingTabId = state.tabs[0]?.tabId ?? null
        return { success: true, closed: index >= 0 }
      }
      case 'close_session': {
        const closed = state.tabs.length
        state.tabs = []
        state.workingTabId = null
        return { success: true, closed }
      }
      case 'snapshot':
        return { url: working(state)?.url ?? state.page.state.url, title: 'Mock fixture', tree: '<html><body><button @e1>Search</button></body></html>' }
      case 'click':
        return { success: true, tag: 'button', text: 'Search' }
      case 'fill':
        return { success: true, tag: 'input', mode: 'value' }
      case 'screenshot':
        return { format: args.format ?? 'png', path: '/tmp/webbridge-mock.png', sizeBytes: 0, mimeType: 'image/png' }
      case 'network':
        return { events: [] }
      case 'upload':
        return { success: true, fileCount: Array.isArray(args.files) ? args.files.length : 0 }
      case 'save_as_pdf':
        return { path: '/tmp/webbridge-mock.pdf', sizeBytes: 0, mimeType: 'application/pdf', pageTitle: 'mock' }
      default:
        return { __error: `unknown mock action ${action}` }
    }
  }
}

