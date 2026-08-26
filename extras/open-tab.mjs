#!/usr/bin/env node
/**
 * open-tab.mjs — 跨平台（macOS / Windows）用 Kimi WebBridge 打开新标签页，
 * 绕过 `navigate(newTab:true)` 在 Vivaldi 等非官方浏览器上的 30s 超时。
 *
 * 原理（2026-08-16 MBP + Win 双机实测验证）：
 *   webbridge 的 `cdp` 工具（chrome.debugger 透传）支持 `Target.createTarget`，
 *   由浏览器原生创建标签（秒级，不经过扩展的 load 事件等待），返回 targetId；
 *   再用 `find_tab {url, active:true}` 借用刚创建的标签，后续 evaluate/snapshot/
 *   click/navigate(不带 newTab) 全部正常。
 *
 * 需要锚标签：cdp 工具要求 session 已有 tab（chrome.debugger 需 attach 到某页）。
 *   - macOS：自动用 osascript 拿用户当前活跃标签 URL 作锚（零打扰，只借用不导航）
 *   - Windows：SSH 会话拿不到活跃标签 URL，用 --anchor 显式传（或任务场景已知
 *     用户在哪个站时直接传目标 url，find_tab 会直接借用成功）
 *
 * 用法：
 *   node open-tab.mjs <url> [session] [--anchor <anchorUrl>] [--daemon <baseUrl>]
 *     url        必填，要打开的页面
 *     session    可选，webbridge session 名，默认 "open-tab"
 *     --anchor   可选，锚标签 URL（Windows 推荐显式传；macOS 自动探测可省略）
 *     --daemon   可选，daemon 地址，默认 http://127.0.0.1:10086
 *                （远程 Win 节点：http://127.0.0.1:10087 隧道）
 *
 * 输出：{ ok, tabId, url, borrowed, method: "borrow"|"create", anchor }
 */
import { execFileSync } from 'node:child_process'

const argv = process.argv.slice(2)
const url = argv.find(a => !a.startsWith('--'))
const session = (argv.find((a, i) => argv[i - 1] === '--session') || '').replace(/^--session$/, '') || 'open-tab'
const anchorArg = (() => { const i = argv.indexOf('--anchor'); return i >= 0 ? argv[i + 1] : null })()
const daemon = (() => { const i = argv.indexOf('--daemon'); return i >= 0 ? argv[i + 1] : 'http://127.0.0.1:10086' })()

if (!url) {
  console.error('usage: node open-tab.mjs <url> [session] [--anchor <anchorUrl>] [--daemon <baseUrl>]')
  process.exit(2)
}

const DAEMON = `${daemon.replace(/\/+$/, '')}/command`
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

function webbridge(action, args, timeoutMs = 15) {
  const res = execFileSync('curl', ['-s', '-m', String(timeoutMs), '-X', 'POST', DAEMON, '-H', 'Content-Type: application/json', '-d', JSON.stringify({ action, args, session })], { encoding: 'utf8' })
  return JSON.parse(res)
}

function fail(msg, extra) {
  console.error(JSON.stringify({ ok: false, error: msg, ...extra }))
  process.exit(1)
}

// ── Step 1: 用户已开着目标页 → 直接借用（零打扰，最优） ─────────────────────
const direct = webbridge('find_tab', { url, active: true })
if (direct.ok && direct.data?.success) {
  console.log(JSON.stringify({ ok: true, tabId: direct.data.tabId, url: direct.data.url, borrowed: true, method: 'borrow' }))
  process.exit(0)
}

// ── Step 2: 拿锚标签（cdp 需要 session 已有 tab） ───────────────────────────
let anchorUrl = anchorArg
if (!anchorUrl) {
  // macOS: osascript 拿用户当前活跃标签 URL（只读，不导航）
  try {
    const probe = execFileSync('osascript', ['-e', 'tell application "Vivaldi" to get URL of active tab of window 1'], { encoding: 'utf8' }).trim()
    if (probe) anchorUrl = probe
  } catch { /* not macOS / Vivaldi not running */ }
}
if (!anchorUrl) {
  fail('need an anchor tab: pass --anchor <url> (Windows/SSH) or ensure Vivaldi is running on macOS', { hint: 'anchor = any tab URL currently open in the browser; cdp requires session to have a tab first' })
}

const anchor = webbridge('find_tab', { url: anchorUrl, active: true })
if (!anchor.ok || !anchor.data?.success) {
  fail(`find_tab anchor failed (${anchorUrl}) — anchor must be the tab the user is currently viewing`, { anchor, hint: 'try --anchor <url-of-the-active-tab>' })
}

// ── Step 3: cdp Target.createTarget 建新标签（秒级，绕过 navigate 超时） ────
const created = webbridge('cdp', { method: 'Target.createTarget', params: { url } }, 20)
if (!created.ok) {
  fail(`Target.createTarget failed: ${created.error?.message ?? JSON.stringify(created)}`, {})
}
// 等待浏览器完成标签创建/激活
await sleep(1200)

// ── Step 4: 借用刚创建的标签 ────────────────────────────────────────────────
const borrowed = webbridge('find_tab', { url, active: true })
if (!borrowed.ok || !borrowed.data?.success) {
  // URL 可能被规范化（尾斜杠/重定向），用当前活动标签兜底
  const probe = webbridge('evaluate', { code: 'location.href' })
  const activeUrl = probe?.data?.value
  if (activeUrl) {
    const retry = webbridge('find_tab', { url: activeUrl, active: true })
    if (retry.ok && retry.data?.success) {
      console.log(JSON.stringify({ ok: true, tabId: retry.data.tabId, url: activeUrl, borrowed: true, method: 'create', targetId: created.data.targetId, anchor: anchorUrl, fallback: true }))
      process.exit(0)
    }
  }
  fail('created tab but find_tab borrow failed', { created, borrowed, probe })
}

console.log(JSON.stringify({ ok: true, tabId: borrowed.data.tabId, url: borrowed.data.url, borrowed: true, method: 'create', targetId: created.data.targetId, anchor: anchorUrl }))
