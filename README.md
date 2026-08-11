# dsh-browser-bridge

在 Chrome 侧边栏里直接嵌入**完整的 DSH Web**，让浏览器里的真实页面成为当前开发对话中的一等公民：DSH 既能像往常一样读写文件、执行命令，也能通过你显式授权的标签页，直接观察、操作和验证页面，而不必换到另一个“浏览器专用对话”里。

## 核心特色

- **侧边栏里就是 DSH Web 本身，不是另一个聊天客户端。** 你在侧边栏看到的正是平时使用的完整 DSH Web，可以打开原有开发对话并延续其上下文；bridge 无需再实现和维护一套独立的对话界面。
- **延续原来的开发对话，而不是另起炉灶。** 不用开新对话，也不必把问题重新描述一遍——在正在进行的开发对话中，通过 **`@当前标签页`** 按钮（或 `@` 引用源 `browser-tabs`）把当前页面显式授权给这一条 prompt，DSH 就能在同一个上下文里继续检查、交互、定位问题、修改代码并验证。
- **页面按 prompt 显式授权。** 授权只对当前这一条 prompt 生效：turn 结束、取消或从队列移除、标签页关闭、桥接断开时自动失效，下一条 prompt 必须重新附加。弹窗、新开的标签页、发送后切换的活动标签页都不会被隐式授权。
- **结构化、有据可查的浏览器证据。** 不是把整个浏览器交给模型，而是通过一组稳定的结构化工具返回证据：DOM 状态、计算样式、几何信息、精确 URL、console 错误、失败的网络请求，以及截图。
- **权限按需且临时的。** CDP 会话在第一次工具调用时才懒附加，turn 结束时自动断开；没有任何访问会隐式延续到未来的 prompt。

## 一个典型的开发闭环

这是本项目的首要使用场景——开发反馈回路：

1. **DSH 修改源码。** 在开发对话中让 DSH 用现有的文件与 Shell 工具改代码，例如调整样式或修复逻辑。
2. **HMR 更新页面。** 开发服务器热更新已经开在 Chrome 里的页面，浏览器立即呈现新版本。
3. **`@当前标签页` 授权。** 在同一个对话的输入框旁点击 **`@当前标签页`**，把正在显示的页面授权给当前 prompt，然后发送。
4. **同一对话中观察、操作、诊断。** DSH 读取真实页面的 DOM、计算样式与几何信息，必要时点击、输入、滚动，并查看 console 错误和失败请求来定位问题。
5. **继续改代码并复验。** 根据浏览器证据再次修改源码，HMR 又一次刷新页面，DSH 继续观察验证，直到结果符合要求。

整个过程中只有一个对话：上下文不丢失，页面只是被显式授权的“证据与操作对象”。例如可以直接接着刚才的开发过程说：

> 刚才改的按钮 hover 还是不对。`@当前标签页` 请在当前页面悬停检查；如果有问题，继续修改源码并复验。

同样的原语也适用于问题复现、信息提取、表单操作等轻量浏览器自动化场景——它不只是一个验收工具，也不是全局的 Computer Use。

## 与 dsh-browser 的关系

[dsh-browser](https://github.com/dsh-external/dsh-browser) 与本项目同属 dsh-external 组织，定位互补，面向不同的工作流：

| 维度 | dsh-browser | dsh-browser-bridge |
| --- | --- | --- |
| 定位 | 浏览器操作优先的轻量侧栏入口 | 嵌入完整 DSH Web 的开发闭环桥梁 |
| 对话形态 | 配套的模型对话侧栏，页面以纯文本呈现 | 直接嵌入完整 DSH Web，复用已有开发对话与上下文 |
| 目标标签页 | 操作当前活动标签页 | 页面按 prompt 显式授权，可同时附加多个标签页 |
| 多页支持 | — | 每个附加页面获得稳定别名（`page_1`、`page_2`……）并附带净化后的标题/URL 元数据 |
| 页面表示与定位 | 编号交互元素清单、跨快照稳定编号与 delta 增量，全程无截图 | DOM/无障碍内容、短生命周期元素引用或选择器 |
| 页面证据 | 结构化纯文本快照 | DOM、计算样式、几何信息、截图、console、network |

简单说：需要轻量、即时的浏览器操作时，dsh-browser 更直接；需要在**已有的开发对话**里让 DSH 检查、修改并验证页面时，dsh-browser-bridge 是延续上下文的那一条路。两者并非替代关系，按工作流选择即可。

## 工作方式（架构）

```text
Chrome side panel
  └─ embedded DSH Web (iframe)
       └─ DSH client plugin
            ├─ @ tab references and shortcut
            └─ origin-checked postMessage
                    ↕
Chrome extension service worker
  ├─ prompt grant vault
  ├─ CDP session manager (chrome.debugger)
  └─ authenticated WebSocket
                    ↕
DSH host plugin (pairing, grants, tools)
                    ↕
DSH agent runtime
```

三个组成部分共享同一个与传输无关的协议包（`packages/protocol`）：

- **`extension/`** —— Manifest V3 侧边栏扩展（React + shadcn 壳），负责标签页发现、prompt 授权（grant）与 `chrome.debugger` 会话；它不实现聊天界面。
- **`packages/dsh-plugin/`** —— 一个可安装的外部 DSH 插件，包含客户端一半（composer 集成）与宿主一半（配对、授权、工具）。
- **`packages/protocol/`** —— 双方共享的带版本号线上协议 schema（配对、授权、桥接请求、工具结果、错误、版本协商）。

## 把标签页授权给 prompt

- 输入框旁的 **`@当前标签页`** 按钮一键附加当前 Chrome 标签页到 prompt。
- **`@`** 引用源（`browser-tabs`）列出可附加的标签页，可以一次附加多个；每个附加页面获得稳定别名（如 `page_1`、`page_2`），并在 prompt 中附带净化后的标题/URL 元数据。
- 授权是**按 prompt 生效**的：turn 完成、被取消、或从队列移除时过期；引用的标签页关闭时过期；桥接断开时过期。下一条 prompt 需要重新附加。
- 弹窗或新打开的标签页永远不会被隐式授权；发送消息后切换活动标签页也不会把授权重定向到新页面。

## 浏览器工具

当一个 prompt 拥有至少一个有效授权时，以下工具仅在该 turn 内存在：`browser_observe`、`browser_inspect`、`browser_screenshot`、`browser_act`、`browser_navigate`、`browser_wait`、`browser_console`、`browser_network`。

| 工具 | 作用 |
| --- | --- |
| `browser_observe` | 返回页面身份、生命周期状态、语义化 DOM/无障碍内容，以及短生命周期的元素引用 |
| `browser_inspect` | 查询指定元素（引用或选择器）的属性、文本、计算样式、几何信息与可见性 |
| `browser_screenshot` | 截取当前视口或指定元素，并返回图片附件证据 |
| `browser_act` | 点击、输入、选择、悬停、聚焦、按键、滚动 |
| `browser_navigate` | 打开 HTTP(S) 地址、后退/前进、刷新 |
| `browser_wait` | 等待元素、文本、URL、生命周期状态，或一段有界的页面稳定窗口 |
| `browser_console` | 返回标签页被附加以来观察到的 console 错误与相关日志 |
| `browser_network` | 返回标签页被附加以来失败的请求与加载错误（不含请求头与请求体） |

元素引用是短生命周期的：页面导航会使全部引用失效，DOM 替换可能使个别引用失效，工具此时返回 `stale_element` 而不是猜测其他目标。

console 与 network 证据有界：从 debugger 附加时开始记录，随授权一起删除；任何情况下都不会返回请求头、请求体、cookie 或密码值。

## 权限与安全边界

- **`debugger`** —— CDP 会话：首次工具调用时懒附加，授权结束时断开。打开 DevTools 会分离会话，并返回可恢复的 `debugger_detached` 错误。
- **`tabs`** —— 仅用于读取标签页标题/URL 供 `@` 引用使用，不记录任何常驻浏览历史。
- **`storage`** —— 本地设置，以及 `chrome.storage.session` 中用于 service worker 启动对账的**非机密**归属台账。
- 只有 HTTP(S) 标签页可附加。
- 首个版本支持本地 DSH Web 来源（`localhost`、`127.0.0.1`）与 Chrome 118+。
- 原始 CDP 透传默认关闭；不支持无痕窗口标签页；默认无遥测；任何访问都不会隐式延续到后续 prompt。
- 如果 DSH Web 无法被嵌入侧边栏，面板会显示可操作的嵌入诊断。
- 意外的跨域跳转会暂停进一步的写入（`navigation_requires_confirmation`），读取仍然可用，直到新的 prompt 显式附加新页面。
- 附加的页面内容只作为**外部证据**注入模型，并被明确标注为证据而非指令。

## 安装与运行

环境要求：Node.js `^22.19.0 || >=24.0.0`（启用 Corepack）、pnpm 11.7.0、Chrome 118+，以及一份本地 DSH 源码检出。

```bash
# 1. 将 DSH 插件链接到本地 DSH 源码检出
pnpm link:dsh -- /absolute/path/to/dsh

# 2. 安装依赖并验证（类型检查 + 单元测试 + 构建）
pnpm install --frozen-lockfile
pnpm check

# 3. 构建插件并安装到 DSH 的 web profile
pnpm --filter @dsh-external/dsh-browser-bridge build
dsh plugin --profile web add /absolute/path/to/dsh-browser-bridge/packages/dsh-plugin
dsh web

# 4. 构建扩展，然后在 chrome://extensions 中启用开发者模式并"加载已解压的扩展程序"
pnpm --filter @dsh-external/dsh-browser-bridge-extension build
pnpm --filter @dsh-external/dsh-browser-bridge-extension zip
```

扩展输出目录为 `extension/output/chrome-mv3`。加载后点击工具栏图标打开侧边栏，第一个界面会让你配置本地 DSH Web 来源（默认 `http://127.0.0.1:3080`），面板随后在 iframe 中嵌入 DSH Web 并显示连接横幅。

完整的分步清单（本地链接、冻结安装、`pnpm check`、插件 profile 安装、解压扩展加载、更新、卸载及逐错误排查）见 **[INSTALL.md](INSTALL.md)**。

## 设计文档

- [设计文档（Approved design）](docs/superpowers/specs/2026-08-10-dsh-browser-bridge-design.md)
- [实现计划（Implementation plan）](docs/superpowers/plans/2026-08-10-dsh-browser-bridge.md)
