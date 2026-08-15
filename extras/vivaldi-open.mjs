#!/usr/bin/env node
/**
 * vivaldi-open.mjs — Kimi WebBridge navigate 超时（Vivaldi）绕行助手
 *
 * 问题背景：webbridge 的 `navigate(newTab:true)` 在 Vivaldi 上会 30s 超时
 * （扩展等待新标签 load 事件的回调不达，`page load timeout (30s)`），
 * 但 `find_tab`(借用现有标签) / `evaluate` / 不带 newTab 的 navigate 全部正常。
 *
 * 绕行原理（已验证，2026-08-14）：
 *   1. 用 AppleScript 让 Vivaldi 直接创建标签页（秒开，不经扩展）
 *   2. 用 webbridge `find_tab {url, active:true}` 借用该标签
 *   3. 之后 `navigate`（不带 newTab）/ evaluate / snapshot / click 全部秒级可用
 *
 * 用法：
 *   node vivaldi-open.mjs <url> [session]
 *     url      必填，要打开的页面
 *     session  可选，webbridge session 名，默认 "vivaldi-open"
 *
 * 输出：{ ok, tabId, url, borrowed, appleScript }
 */
import { execFileSync } from 'node:child_process'

const [url, session = 'vivaldi-open'] = process.argv.slice(2).filter(a => !a.startsWith('--'))
if (!url) {
  console.error('usage: node vivaldi-open.mjs <url> [session]')
  process.exit(2)
}

const DAEMON = 'http://127.0.0.1:10086/command'

function osa(script) {
  return execFileSync('osascript', ['-e', script], { encoding: 'utf8' }).trim()
}

function webbridge(action, args, timeoutMs = 15) {
  const res = execFileSync('curl', ['-s', '-m', String(timeoutMs), '-X', 'POST', DAEMON, '-H', 'Content-Type: application/json', '-d', JSON.stringify({ action, args, session })], { encoding: 'utf8' })
  return JSON.parse(res)
}

// 1. AppleScript 创建标签（秒开，绕过扩展的新标签 load 等待）
let tabLine
try {
  tabLine = osa(`tell application "Vivaldi"
    tell window 1
      make new tab with properties {URL:"${url.replaceAll('"', '\\"')}"}
    end tell
  end tell`)
} catch (e) {
  console.error(JSON.stringify({ ok: false, error: `AppleScript failed: ${e.message}` }))
  process.exit(1)
}

// 2. 等 Vivaldi 完成激活，然后 webbridge 借用该标签
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
await sleep(1500)

const borrowed = webbridge('find_tab', { url, active: true })
if (!borrowed.ok || !borrowed.data?.success) {
  // 兜底：URL 可能被规范化（尾斜杠等），用活动标签再试
  const probe = webbridge('evaluate', { code: 'location.href' })
  const activeUrl = probe?.data?.value
  if (activeUrl) {
    const retry = webbridge('find_tab', { url: activeUrl, active: true })
    if (retry.ok && retry.data?.success) {
      console.log(JSON.stringify({ ok: true, tabId: retry.data.tabId, url: activeUrl, borrowed: true, fallback: true, appleScript: tabLine }))
      process.exit(0)
    }
  }
  console.error(JSON.stringify({ ok: false, error: 'find_tab borrow failed', borrowed, probe }))
  process.exit(1)
}

console.log(JSON.stringify({ ok: true, tabId: borrowed.data.tabId, url: borrowed.data.url, borrowed: true, appleScript: tabLine }))
