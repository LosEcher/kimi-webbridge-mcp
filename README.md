# kimi-webbridge-mcp

把本地 **Kimi WebBridge** daemon（`http://127.0.0.1:10086`）包装成标准 **MCP stdio server**，
让任何 MCP 客户端都能用真实浏览器工具：DSH（`@deepseek-ai/dsh-mcp-client`）、Claude Code、Codex 等。

零依赖：单个 `server.mjs`，Node ≥ 18 直接运行，新行分隔 JSON-RPC 2.0 over stdio。

> Kimi 官方 `kimi-webbridge install-skill` 只会把 skill 装进 Claude Code / Codex / Kimi CLI / Hermes，
> **不装 DSH**。本仓库补上 DSH（及任意 MCP 客户端）这一环，且工具带 JSON Schema，
> 优于纯文本 skill 调用。

## 快速开始

```bash
# 1. daemon 就绪？（没有会自动拉起）
~/.kimi-webbridge/bin/kimi-webbridge status

# 2. 冒烟测试（mock 模式不碰浏览器；真实模式只做只读调用）
node test/test-client.mjs --mock
node test/test-client.mjs

# 3. 任意 MCP 客户端指向这个命令即可：
node path/to/kimi-webbridge-mcp/server.mjs   # 或安装后直接 webbridge-mcp
```

## 接入 DSH

安装 bundle 后用自带的 overlay 补丁（`@deepseek-ai/dsh-mcp-client` 插件，stdio transport）：

```bash
dsh plugin --profile web add github:LosEcher/kimi-webbridge-mcp#main
dsh web --patch <path/to/dsh-webbridge.cordis.yml>
```

工具以 `mcp__webbridge__<name>` 出现在模型面前（如 `mcp__webbridge__navigate`）。
想永久启用，把 `dsh-webbridge.cordis.yml` 里的 `insert` 合并进 `$DSH_HOME/cordis.patch.yml`
（或对应 profile 的 `cordis.patch.yml`）。

## 工具

| MCP 工具 | 说明 | 关键参数 |
|---|---|---|
| `navigate` | 打开 URL（真实浏览器） | `url`*、`newTab`、`group_title` |
| `find_tab` | 重选本会话打开的标签页；`active:true` 借用用户正在看的页 | `url`*、`active` |
| `snapshot` | 当前页无障碍树（文本），返回 `@e` 引用 | — |
| `click` | 点击元素（`@e` 引用或 CSS） | `selector`* |
| `fill` | 填输入框/textarea/contenteditable（clear-and-insert） | `selector`*、`value`* |
| `evaluate` | 页内执行 JS（支持 async） | `code`* |
| `cdp` | chrome.debugger 原始 CDP 透传（逃生通道） | `method`*、`params` |
| `screenshot` | 截图（整页或元素），返回本地文件路径 | `format`、`quality`、`selector`、`path` |
| `network` | 网络活动采集/查看 | `cmd`*(start/stop/list/detail)、`filter`、`requestId` |
| `upload` | 上传文件到 `<input type=file>` | `selector`*、`files`* |
| `save_as_pdf` | 当前页存 PDF，返回本地路径 | `paper_format`、`landscape`、`scale`、`print_background`、`path` |
| `list_tabs` | 列出会话内标签页 | — |
| `close_tab` | 关闭当前标签页 | — |
| `close_session` | 关闭会话全部标签页（仅用户明确要求时调用） | — |
| `webbridge_status` | daemon/扩展状态（走 `kimi-webbridge status` CLI） | — |

所有工具都接受可选 `session` 参数：**一个任务 = 一个 session = 一个标签组**，
同一任务的所有调用传同一个 session（缺省 `webbridge-mcp`）。
`group_title`（用户语言的可见组名）在任务的第一次 `navigate` 上设置。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `WEBBRIDGE_DAEMON_URL` | `http://127.0.0.1:10086` | daemon 地址 |
| `WEBBRIDGE_DAEMON_BIN` | `~/.kimi-webbridge/bin/kimi-webbridge` | 自动拉起/状态查询用的 CLI |
| `WEBBRIDGE_MCP_TIMEOUT_MS` | `60000` | 单次调用超时 |
| `WEBBRIDGE_MCP_AUTOSTART` | `1` | 连接失败时自动 `kimi-webbridge start`（幂等） |
| `WEBBRIDGE_MCP_DEFAULT_SESSION` | `webbridge-mcp` | 缺省会话名 |
| `WEBBRIDGE_MCP_MOCK` | `0` | `1` = 罐头响应，不碰 daemon/浏览器（测试用） |

## 行为与协议

- **daemon 合约**（v1.11.x）：`POST /command` body `{action, args, session}`；
  成功 `{ok:true, ...result}`（兼容 `{ok:true, data:{...}}`），失败 HTTP 502 + `{ok:false, error:{code,message}}`。
- **错误传播**：daemon 的 `code`/`message` 原样透出为 MCP `isError` 结果，例如
  `no extension connected`、`session "x" has no tab — navigate or find_tab first`。
- **自动拉起**：连接被拒（daemon 未运行）时自动 `kimi-webbridge start` 一次并重试；
  扩展未连接这类业务错误不触发拉起。
- **结果**：统一以 `text` 块返回 JSON 字符串；`screenshot`/`save_as_pdf` 返回**本地文件路径**，
  由模型用 Read 工具读图/读 PDF（daemon 协议本来就不回 base64）。

## 故障排查

- `{"error":"... no extension connected"}` → 浏览器扩展未连接：打开浏览器连接 Kimi WebBridge
  扩展（帮助页 https://www.kimi.com/zh-cn/features/webbridge ），再重试。
- `webbridge extension_error: ...` / `tool_error: session "x" has no tab` → 先 `navigate` 或 `find_tab`。
- `daemon unreachable` 且自动拉起失败 → 手动 `~/.kimi-webbridge/bin/kimi-webbridge start`，`status` 确认。
- 提示"Please update the Kimi WebBridge extension" → 扩展版本落后，让用户更新扩展（不要自行处理）。
- **Vivaldi（非官方支持浏览器）上 `navigate(newTab:true)` 必现 `page load timeout (30s)`**：
  扩展等新标签 `load` 事件回调 30s 超时（连 `about:blank` 也一样），官方只支持 Chrome/Edge。
  但 `find_tab`（借用现有标签）、`evaluate`、以及借用后不带 `newTab` 的 `navigate` 全部正常。
  绕行：先用 AppleScript 让 Vivaldi 建标签（秒开），再用 `find_tab active:true` 借用，
  之后一切操作正常。已封装为 `./vivaldi-open.mjs <url> [session]`（见下方示例）。

```bash
# Vivaldi 绕行打开页面（替代 navigate(newTab:true)）——macOS 专属（AppleScript）
node extras/vivaldi-open.mjs "https://example.com" my-session
# → {"ok":true,"tabId":...,"url":"https://example.com","borrowed":true}
# 然后对 my-session 正常用 evaluate / snapshot / click / navigate(不带 newTab)
```

## 安全注意

工具操作的是**用户真实浏览器及其登录态**。不要在用户未要求时打开敏感页面；
`close_session` 只在用户明确要求关闭标签时调用（工具描述里已写明该约束）。
