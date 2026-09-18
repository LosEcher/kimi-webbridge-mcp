# kimi-webbridge-mcp

把本地 **Kimi WebBridge** daemon（`http://127.0.0.1:10086`）包装成标准 **MCP stdio server**，
让任何 MCP 客户端都能用真实浏览器工具：DSH（`@deepseek-ai/dsh-mcp-client`）、Claude Code、Codex 等。

零依赖：Node ≥ 18 直接运行，新行分隔 JSON-RPC 2.0 over stdio。

> Kimi 官方 `kimi-webbridge install-skill` 只会把 skill 装进 Claude Code / Codex / Kimi CLI / Hermes，
> **不装 DSH**。本仓库补上 DSH（及任意 MCP 客户端）这一环，且工具带 JSON Schema，
> 优于纯文本 skill 调用。

## v1.1.0：守卫化快环（obs / act / open_tab）

这一版补上三件事，用来修「agent 说点了、也报成功、页面没动」和「navigate 挂死」这两个真实痛点：

| 新工具 | 做什么 |
|---|---|
| **`obs`** | **一次页内读取**的原子观测：索引元素表（`ref`/`kind`/`role`/`name`/`value`）+ 可见文本 + 滚动状态，模型面载荷有字符预算（默认 4000，超出显式记 `omitted`/`truncated`）。替代 `snapshot`（AX 树文本，实测 p50 **45.5k 字符** ≈ 11k tokens，真实页还会截断）。 |
| **`act`** | **守卫化执行**：先一次页内复核（还在 DOM 里？未禁用？可见？在视口内？未被遮挡？role/name/value/周围文本没变？），**不匹配就拒绝且一个事件都不派发**；匹配才走真 `Input.*`（`dispatchMouseEvent` / `insertText` / `dispatchKeyEvent`），并校验事件真的落在目标元素上。几何在 act 时**重新解析**——元素只是移动了照样能点到。 |
| **`open_tab`** | 不依赖 `navigate` 的标签页生命周期：复用会话已有标签 → 在其中 `cdp Page.navigate` → 借用用户已经打开的页 → 最后才「一次性」尝试后台建标签；每步都带客户端超时预算，失败不盲目重试。 |

`ref` 是**身份 + 代号的不可复用字符串**（形如 `o3:17`），不是位置编号：
旧 ref 要么仍指向**同一个**节点（且含义未变才放行），要么明确失败（`detached` / `node gone`）。
对比扩展自带 `@e1`：它按位置复用，跨快照使用会静默点到**别的**元素并返回 `success:true`。

### 实测数字（2026-09-18，本机 Vivaldi + 扩展 2.0.13 / daemon v2.0.15）

真机实测（`test/e2e-live.mjs` 跑通的部分）：

| 项 | 数值 |
|---|---|
| `obs` 载荷 / 往返 | **3729 字符，1 次页内读取，22–26 ms**（同页 AX 树为 45.5k 字符） |
| `act` 干净点击 | **85 ms**，`delivered:true`，落在目标 `BUTTON#go` 上，页面状态 `idle → searched`，`__clicks = {any:1, trusted:1, dom:0}` |
| `act` 语义漂移（改名后点旧 ref） | **拒绝，零输入**：`reason_code:"semantic_drift"`、`no_input_dispatched:true`、`__clicks.any` 保持 0 |
| `act` 目标位移 300–500 px | **照样命中**：观测时中心 y=258 → 实际派发 y=557，命中原元素 |
| `act` 元素被移除 / 页面重载 | **拒绝**（`detached` / 页面身份变化），零输入 |
| 后台标签保活 | 真·后台标签（`document.hidden:true`）rAF **0/s → 120/s**（`Emulation.setFocusEmulationEnabled` 开/关同标签对照） |
| `open_tab` 建标签（cdp） | 创建 **9–21 ms**，整轮 432–460 ms；**用户可见标签不变** |

`navigate` 为什么被绕开（同一实测，代码级定位）：

- 扩展的就绪判定是**精确 URL 相等**（`tab.url !== requested && tab.url !== requested + '/'`），任何重定向/归一化都要走满 30 s；
- 当前版本更糟：30 s 计时器里包着一次 **300 s** 超时的 CDP 调用 → 表现为**无界挂死**（`curl -m 200` 连 502 信封都收不到），且 **不创建标签**；
- 实测：`navigate` 3/3 抢焦点但不绑定会话；`Target.createTarget` 创建后**是否被会话收养只有 1/3–2/3**（扩展只在 Chrome 盖上 `openerTabId` 时经 `/internal/tab-adopted` 收养，`cdp` 是无白名单盲转发，没有确定性绑定）。

因此 `open_tab` 的可靠性来自「**不新建标签**」：复用会话标签 + `cdp Page.navigate` + 自己轮询 `document.readyState`/URL 就绪，
只在会话一个标签都没有时才建一次；建失败会如实报 `created:true, adopted:false, orphan_warning:true`。

### 会话信任守卫（重要安全行为）

标签绑定是显式记账的。`open_tab` 在借用用户标签当 CDP 锚之后若没能绑定自己的标签，
**会话会被标记为不可信**，此后 `obs`/`act` 直接拒绝（`reason_code:"session_unbound"`，且**不读取任何页面**），
直到有一次成功的绑定（`open_tab` / `find_tab` / `navigate`）。`close_tab` 之后同样会失效。
需要故意操作「当前是什么标签就操作什么」时传 `allow_any_tab:true` 显式覆盖。

这条不是洁癖：真机实测过一次 `open_tab` 建标签失败后，会话的工作标签停在**借用的用户标签**上，
下一次 `obs` 读到的就是用户正在用的内部业务系统页面。守卫让这种状态 `fail-closed`。

### 已知限制（诚实清单）

- **建标签不可靠**：扩展没有确定性绑定 API（`Target.activateTarget`/`getTargets` 均被拒 `-32000 Not allowed`）。
  建失败会在浏览器里留下**孤儿标签**：它不在任何会话里，`find_tab`/`close_tab` 都够不到，只能手动关。
  所以本 wrapper **一次只建一次、绝不重试**；`open_tab` 会明确告诉你可能留下了哪个 URL 的标签。
- **`ref` 的语义新鲜度是启发式**：`pageKey`（导航身份 + 视口）+ 每节点 guard（含作用域文本）变化即拒绝。
  作用域文本变化可能来自无关区域 → 会**误拒**（误拒是安全的：`act` 会附带一次新观测让你重决策）。
- **`obs` 覆盖不到的地方**：iframe / shadow DOM / canvas / 上传 / 新窗口 —— 这些继续用 `snapshot` + `click`/`fill`。
- **`obs` 只列视口内元素**（和 jev 一致）：需要页面下方的元素时先滚动再 `obs`。
- `Page.setWebLifecycleState` 只是 best-effort 兜底，失败不影响 `keep_alive.focus_emulation`。

## 快速开始

```bash
# 1. daemon 就绪？（没有会自动拉起）
~/.kimi-webbridge/bin/kimi-webbridge status

# 2. 浏览器无关门禁（语法 + 单测 + 假 daemon 走完整 MCP stdio）
bash test/gates.sh

# 3. 真机端到端（需扩展在线；会开 1 个后台标签，跑完自动清场）
bash test/gates.sh --live

# 4. 任意 MCP 客户端指向这个命令即可：
node path/to/kimi-webbridge-mcp/server.mjs   # 或安装后直接 webbridge-mcp
```

`bash test/gates.sh` 只跑**不碰浏览器**的门禁：`node --check` 全部源文件 + fixture 内联脚本、
`node --test test/unit.test.mjs`（41 例）、`node test/mcp-smoke.mjs --mock`（假 daemon 走完整 MCP 协议）。
真机 E2E 默认**显式跳过并打印**，不会静默算通过；`--live` 才跑，无扩展时退出码 3（SKIP）。

## 接入 DSH

安装 bundle 后用自带的 overlay 补丁（`@deepseek-ai/dsh-mcp-client` 插件，stdio transport）：

```bash
dsh plugin --profile web add github:LosEcher/kimi-webbridge-mcp#main
dsh web --patch <path/to/dsh-webbridge.cordis.yml>
```

工具以 `mcp__webbridge__<name>` 出现在模型面前（如 `mcp__webbridge__obs`）。
想永久启用，把 `dsh-webbridge.cordis.yml` 里的 `insert` 合并进 `$DSH_HOME/cordis.patch.yml`
（或对应 profile 的 `cordis.patch.yml`）。

> 升级后让 DSH 看到新工具：不需要重启宿主。MCP 客户端带重连策略（默认 `enabled:true`、
> 500 ms 起、10 次），杀掉旧的 `server.mjs` 子进程后客户端会重连并重新注册工具；
> 也可以直接重启宿主。装的是 `github:` 依赖时注意 `pnpm update kimi-webbridge-mcp` 才会拉到新提交。

## 工具

### 快环（优先用这三个）

| MCP 工具 | 说明 | 关键参数 |
|---|---|---|
| `obs` | 一次页内读取的原子观测：索引元素表 + 可见文本 + 滚动状态 | `max_chars`(4000)、`max_elements`(120)、`text_chars`(1200)、`include_rect`、`keep_alive` |
| `act` | 守卫化执行：复核不通过即拒绝且零输入；通过则走真 `Input.*` 并校验送达 | `ref`*、`kind`(click/fill/press/select)、`text`、`key`、`value`、`settle_ms`(40)、`verify_delivery`、`refresh` |
| `open_tab` | 不依赖 `navigate` 的标签页生命周期：复用 → 会话内换页 → 借用 → 一次性建标签 | `url`*、`reuse`、`can_create`、`ready_timeout_ms`(5000)、`anchor` |

### 完整面（逃生通道，语义与 1.0 一致）

| MCP 工具 | 说明 | 关键参数 |
|---|---|---|
| `navigate` | 打开 URL（真实浏览器）。**可能无界挂死**，已被预算包住并提示改用 `open_tab` | `url`*、`newTab`、`group_title` |
| `find_tab` | 重选本会话打开的标签页；`active:true` 借用用户正在看的页 | `url`*、`active` |
| `snapshot` | 当前页无障碍树（文本），返回 `@e` 引用（**位置化，勿跨快照复用**） | — |
| `click` | 点击元素（`@e` 引用或 CSS，**无守卫**） | `selector`* |
| `fill` | 填输入框/textarea/contenteditable（clear-and-insert，无守卫） | `selector`*、`value`* |
| `evaluate` | 页内执行 JS（支持 async） | `code`* |
| `cdp` | chrome.debugger 原始 CDP 透传（逃生通道；要求会话已有标签） | `method`*、`params` |
| `screenshot` | 截图（整页或元素），返回本地文件路径 | `format`、`quality`、`selector`、`path` |
| `network` | 网络活动采集/查看 | `cmd`*(start/stop/list/detail)、`filter`、`requestId` |
| `upload` | 上传文件到 `<input type=file>` | `selector`*、`files`* |
| `save_as_pdf` | 当前页存 PDF，返回本地路径 | `paper_format`、`landscape`、`scale`、`print_background`、`path` |
| `list_tabs` | 列出会话内标签页 | — |
| `close_tab` | 关闭当前（工作）标签页 | — |
| `close_session` | 关闭会话**全部**标签页（含借用的用户标签，仅用户明确要求时调用） | — |
| `webbridge_status` | daemon/扩展状态（走 `kimi-webbridge status` CLI） | — |

所有工具都接受可选 `session` 参数：**一个任务 = 一个 session = 一个标签组**，
同一任务的所有调用传同一个 session（缺省 `webbridge-mcp`）。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `WEBBRIDGE_DAEMON_URL` | `http://127.0.0.1:10086` | daemon 地址 |
| `WEBBRIDGE_DAEMON_BIN` | `~/.kimi-webbridge/bin/kimi-webbridge` | 自动拉起/状态查询用的 CLI |
| `WEBBRIDGE_MCP_TIMEOUT_MS` | `60000` | 单次调用缺省预算 |
| `WEBBRIDGE_MCP_OBS_TIMEOUT_MS` | `15000` | `obs` 页内读取预算 |
| `WEBBRIDGE_MCP_ACT_TIMEOUT_MS` | `10000` | `act` 前置复核预算 |
| `WEBBRIDGE_MCP_ACT_INPUT_TIMEOUT_MS` | `8000` | `act` 输入/校验预算 |
| `WEBBRIDGE_MCP_OBS_MAX_CHARS` | `4000` | `obs` 模型面字符预算 |
| `WEBBRIDGE_MCP_OBS_MAX_ELEMENTS` | `120` | `obs` 元素上限 |
| `WEBBRIDGE_MCP_OBS_TEXT_CHARS` | `1200` | `obs` 可见文本上限 |
| `WEBBRIDGE_MCP_AUTOSTART` | `1` | 连接失败时自动 `kimi-webbridge start`（幂等） |
| `WEBBRIDGE_MCP_DEFAULT_SESSION` | `webbridge-mcp` | 缺省会话名 |
| `WEBBRIDGE_MCP_MOCK` | `0` | `1` = 进程内假 daemon（有状态假页面），不碰真 daemon/浏览器（测试用） |
| `WEBBRIDGE_MCP_DEBUG` | `0` | `1` = 每步诊断（含 act 拒绝原因）打到 stderr |

## 行为与协议

- **daemon 合约**（v2.x）：`POST /command` body `{action, args, session}`；
  成功 `{ok:true, data:{...}}`（兼容 `{ok:true, ...result}`），失败 HTTP 502 + `{ok:false, error:{code,message}}`。
- **超时语义**：所有调用都带客户端预算；超时返回 `timedOut:true`（变更类调用另带 `unknownEffects:true`），
  **绝不自动重试**——daemon 可能在你放弃之后才落盘（`mayHaveLateEffects`），盲目重试就是重复写入。
- **错误传播**：daemon 的 `code`/`message` 原样透出为 MCP `isError` 结果；`obs`/`act` 的**拒绝是正常结果**
  （`ok:false` + `stale:true` + `no_input_dispatched:true`），不是 `isError`，便于脚本断言。
- **结果**：统一以 `text` 块返回 JSON 字符串；`screenshot`/`save_as_pdf` 返回**本地文件路径**。

## 故障排查

- `{"error":"... no extension connected"}` → 浏览器扩展未连接：打开浏览器连接 Kimi WebBridge
  扩展，再重试。
- `session "x" has no tab — navigate or find_tab first` → cdp 类调用要求会话先有标签：
  `open_tab` 或 `find_tab`。
- `obs`/`act` 返回 `session_unbound` → 上一次标签绑定失败/工作标签被关：再调一次 `open_tab`
  （会复用或重开），或在浏览器里自己打开目标页后调 `open_tab`（会被借用）。
- `open_tab` 返回 `orphan_warning:true` → 浏览器建了标签但扩展没能绑定：那个标签可能残留在浏览器里，
  手动关掉即可；重试前先看清提示里的 URL。
- `navigate` 超时 → 见上文机制；改用 `open_tab`，或在已借用的标签上用不带 `newTab` 的 `navigate`。
- 提示 "Please update the Kimi WebBridge extension" → 扩展版本落后，让用户更新扩展（不要自行处理）。
- **Vivaldi（非官方支持浏览器）上 `navigate(newTab:true)` 必现 `page load timeout (30s)`**，
  且当前版本会无界挂死。`extras/open-tab.mjs` 是历史遗留的独立绕行脚本（本 wrapper 内置能力已覆盖，
  保留给不使用 MCP 的场景）：

```bash
node extras/open-tab.mjs "https://example.com" my-session
node extras/open-tab.mjs "https://example.com" my-session --anchor "https://weibo.com" --daemon "http://127.0.0.1:10087"  # Win 经隧道
```

## 安全注意

工具操作的是**用户真实浏览器及其登录态**。

- 不要在用户未要求时打开敏感页面；`close_session` 只在用户明确要求关闭标签时调用。
- **借用来的用户标签不是你的**：只读使用，绝不导航/关闭。`open_tab` 不会把借用标签当作换页目标；
  但如果你自己用 `find_tab(active:true)` 借了用户的标签，随后 `close_tab`/`close_session` 会**关掉它**。
- 测试脚本的纪律：`test/e2e-live.mjs` 只用 URL 限定的清场（API + AppleScript 两次都以 fixture origin 为准），
  不会碰用户标签；历史异常残留可用 `node test/cleanup-tabs.mjs --sessions <名,名>` 按 URL 精确清理。

## 出处

页内原子快照（`lib/snapshot.page.js`）改编自 [browser-use/jev-ultrafast](https://github.com/browser-use/jev-ultrafast)
的 `jev_ultrafast/snapshot.js`（MIT）；本仓库的三处偏离与理由写在 `lib/snapshot.page.js` 头部：
命名空间改为 `__wbObs`、`pageKey` 去掉滚动与表单状态（几何与滚动都在 act 时重解析）、
guard 由数组改为具名字段对象（为了给出「哪个字段变了」的可执行拒绝原因）。
