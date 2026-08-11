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
3. **`@当前标签页` 授权。** 在同一个对话的输入框上方点击 **`@当前标签页`**，把正在显示的页面授权给当前 prompt，然后发送。
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

- 输入框上方的 **`@当前标签页`** 按钮一键附加当前 Chrome 标签页到 prompt。按钮通过 DSH 官方 `conversation.input.dock` slot（注册序 30）显示在输入框正上方：排在 Todo(0)、Goal(10)、Queue(20) 等输入 dock 条目之后、最靠近输入框，左边缘与输入卡片对齐、垂直间距 6px；空白首页（hero）下宿主间距为 12px，由插件 CSS 补偿为同样的 6px，因此空白首页与已有对话中位置一致。
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

## Vite Provider：无需扩展的页面接入

Chrome Extension 与 Vite provider 是**互补**的接入方式，而非替代关系：

| 维度 | Chrome Extension | Vite Provider |
| --- | --- | --- |
| 安装 | 加载解压扩展 | 零安装，Vite 插件注入 |
| 页面 | 任意标签页（CDP） | 由当前 Vite 构建承载的页面 |
| 能力 | 全部 `browser_*`（含截图、network） | 可靠子集：observe、inspect、act、navigate、wait、console |
| 证据 | DOM、CDP、原生截图、浏览器级 console/network | DOM 语义投影、合成输入、HMR generation、console 缓冲 |
| 前提 | Chrome 118+ | 页面由你的 Vite 构建注入 Runtime |

### 安装与配置

```bash
pnpm add -D @dsh-external/dsh-browser-bridge-vite
```

```ts
import { dshBrowserBridge } from '@dsh-external/dsh-browser-bridge-vite'

export default defineConfig({
  plugins: [
    dshBrowserBridge({
      dshOrigin: 'http://127.0.0.1:3080',
      bridge: {
        enabled: true,
        injectInBuild: false,      // 生产构建默认不注入
        autoConnectInBuild: false, // 显式注入后默认休眠
      },
      panel: {
        enabled: true,             // false 只关闭嵌入 UI，bridge 仍可用
        visible: false,            // true 仅做健康探测，成功后显示入口
        shortcut: 'Alt+Shift+D',
        queryParameter: 'dsh',
      },
    }),
  ],
})
```

- **开发环境默认自动连接**本地 DSH 并注册页面 target。
- **生产构建默认不注入**；显式 `injectInBuild: true` 后仍默认**休眠**（零本地网络请求），只有快捷键、`?dsh=1` 或本地激活开关才会激活；`autoConnectInBuild: true` 才允许每个访问者主动探测并连接。
- `dshOrigin` 只接受回环地址：`localhost`、`*.localhost`、`127.0.0.0/8`、`::1`。配置拒绝凭据、非 HTTP(S) 与远程地址，且不扫描端口。
- 所有配置都会进入前端产物：schema 拒绝任何秘密形态的字段，不要把 token/密钥放进配置。

### 引用与授权（与扩展一致的显式边界）

- `@开发页面`：从本地 Host 回读所有已连接的 Vite target，可一次附加多个。
- `@当前开发页`：仅当 DSH Web 嵌在目标页面（Shadow DOM 面板）中出现，指向承载当前面板的 target，且 targetId 与 origin 必须通过 Host 回读校验。
- 附加只创建 composer 引用；发送 prompt 时才申请一次性 grant，绑定 session/turn/target；没有引用就没有模型工具。turn 完成、取消、移除、超时、页面关闭、跨 origin 离开都会撤销授权。

### 可靠能力表

| 工具 | Vite 支持 | 说明 |
| --- | --- | --- |
| `browser_observe` | ✅ | 有界语义 DOM 投影、ARIA、短生命周期引用 |
| `browser_inspect` | ✅ | 属性/文本/白名单计算样式/几何/可见性，敏感值遮罩 |
| `browser_act` | ✅ | click/type/select/focus/press/scroll；受控输入走原生 setter + input/change；hover 为合成事件（`synthetic: true, cssPseudoState: false`） |
| `browser_navigate` | ✅ | 仅同源 URL/前进/后退/刷新；跨 origin 在导航前拒绝 |
| `browser_wait` | ✅ | selector/text/url/ready/稳定窗口/下一 generation |
| `browser_console` | ✅ | 注入后的 console、window error、unhandledrejection，有界 200 条并带 generation |
| `browser_screenshot` | ❌ | 返回稳定 `unsupported_operation` |
| `browser_network` | ❌ | 返回稳定 `unsupported_operation` |

HMR 会使旧元素引用失效（`stale_element`），并递增 generation；断线后的写操作绝不自动重放。生产页面没有 HMR capability，generation 等待返回 `unsupported_operation`。

### 本地 DSH-only 边界与 CSP

- Runtime 只连接**本机回环** DSH；不保存 token、grant 或页面证据到 localStorage/扩展存储；唯一的持久化写入是用户显式激活开关。
- Host 侧 Vite broker 默认**只接受回环 origin 的页面注册**（`localhost`、`*.localhost`、`127/8`、`::1`），远程站点页面无法注册为 target；确需放行非回环 origin 时，可在插件配置中显式设置 `viteAllowedOrigins: ['https://example.com']`。
- Vite WebSocket 升级与 `/targets`、`/grants` 一样要求**回环 Host 头**（防 DNS rebinding），且握手 `Origin` 必须与页面声明 origin 精确一致（浏览器必带 Origin，缺失即拒绝）。
- 生产站点若设置 CSP，需在响应头中允许所选回环来源，例如：

```text
frame-src   http://127.0.0.1:* http://localhost:*;
connect-src http://127.0.0.1:* http://localhost:*
            ws://127.0.0.1:* ws://localhost:*;
```

插件不会放宽服务器响应头中的 CSP，只会给出文档与运行时诊断：面板嵌入失败显示 `embedding_blocked` 诊断与“在新标签页打开本地 DSH”的降级入口；本地网络/连接被阻止时显示失败横幅与重试。

### 验收状态

Chromium 自动化（Playwright）已覆盖注入、观察/操作、React/Vue 受控输入、HMR、多页面路由、unsupported 能力、HTTPS 生产 fixture 与 CSP 诊断（`e2e/vite-provider.spec.ts`、`e2e/vite-security.spec.ts`）。**真实 Chrome 与 Arc 人工门禁**按计划单独记录在
[docs/testing/vite-provider-manual.md](docs/testing/vite-provider-manual.md)，截至 2026-08-11 状态为**未完成**（需要运行中的真实 DSH 实例），不得以 Chromium 结果推断通过。

## 设计文档

- [设计文档（Approved design）](docs/superpowers/specs/2026-08-10-dsh-browser-bridge-design.md)
- [实现计划（Implementation plan）](docs/superpowers/plans/2026-08-10-dsh-browser-bridge.md)
- [Vite Provider 设计（Approved design）](docs/superpowers/specs/2026-08-11-dsh-browser-bridge-vite-design.md)
- [Vite Provider 实现计划（Implementation plan）](docs/superpowers/plans/2026-08-11-dsh-browser-bridge-vite.md)
- [Chrome/Arc 人工门禁（Manual gate）](docs/testing/vite-provider-manual.md)
