# DSH Browser Bridge Vite Provider 设计

日期：2026-08-11
状态：已确认，可进入实现计划评审

## 1. 摘要

`dsh-browser-bridge` 将新增一个 Vite provider，使由 Vite 承载的页面无需
Chrome Extension，也能被同一个 DSH 开发对话显式附加、操作、诊断和复验。
Vite 插件向页面注入一个框架无关的 Runtime；Runtime 直接连接本机 DSH，
并可选地在 Shadow DOM 侧栏中嵌入完整 DSH Web。

这个 provider 服务于“自己正在开发或测试的页面”。它与 Chrome Extension
互补，而不是替代关系：

- Vite provider 强调零安装、项目感知、HMR 生命周期和开发闭环。
- Chrome Extension 保留任意页面、CDP、原生截图、浏览器级 console/network、
  Accessibility Tree 和更高保真的输入能力。

用户仍然必须在 prompt 中使用 `@当前开发页` 或 `@开发页面` 显式授权。
页面被注入 Runtime、连接本地 DSH 或打开侧栏，都不等于自动授权模型。

## 2. 目标

- 让 Vite 开发页面无需安装浏览器扩展即可接入 DSH Browser Bridge。
- 在目标页面中可选地直接打开完整 DSH Web，并延续已有开发对话。
- 即使关闭嵌入面板，仍可从独立 DSH Web 中附加已连接的 Vite 页面。
- 开发环境和显式启用的生产构建共用一套页面直连传输。
- 保留现有 prompt-scoped grant、`page_n` 别名和 turn 生命周期约束。
- 用可靠的 DOM、样式、交互、等待、导航、HMR 和 console 证据支持开发闭环。
- 保持现有 Chrome Extension wire protocol 兼容，不伪造 Chrome `tabId` 或
  `windowId`。
- 仅允许连接本机回环地址上的 DSH Web，不支持远程 DSH。
- 仅修改当前外部仓库，不修改 DSH 源码。

## 3. 非目标

- 用 Vite provider 替代 Chrome Extension。
- 控制不是由当前 Vite 构建注入 Runtime 的任意页面。
- 在首版模拟或降级实现 `browser_screenshot`、`browser_network`。
- 提供浏览器原生 trusted input、CSS `:hover` 强制状态、跨域 iframe 控制、
  下载、文件选择器、权限弹窗或浏览器 UI 操作。
- 在首版关联源码模块、组件树、构建错误与 DOM 节点。
- 把 Vite dev server 作为运行时必须存在的中转服务。
- 在前端构建产物中保存 DSH token、cookie、grant 或其他秘密。
- 自动把已连接页面加入模型上下文，或让授权跨 prompt 延续。

## 4. 方案比较

### 4.1 页面 Runtime 直连本地 DSH——采用

Vite 插件只负责注入和配置。页面 Runtime 在开发与生产构建中都直接连接本机
DSH，嵌入面板只是可选 UI。该方案让 `panel.enabled: false` 仍可使用 bridge，
并避免为开发和生产维护两种传输。

### 4.2 开发环境通过 Vite Server，生产环境直连 DSH——不采用

开发时可以复用 HMR WebSocket，但生产仍需另一套页面直连协议。两套重连、
授权和错误处理会扩大测试矩阵，且 Vite server 并不应成为 bridge 的架构依赖。

### 4.3 通过 DSH Web iframe 中转——不采用

目标页面只与 iframe 通信，隔离直观，但关闭面板后页面无法注册到独立 DSH
Web，导致 bridge 生命周期被 UI 生命周期绑定，不符合已确认的产品语义。

## 5. 架构

```text
Vite page
  └─ injected page runtime
       ├─ target registration and local DSH connection
       ├─ DOM browser-tool executor
       ├─ HMR and console evidence
       └─ optional Shadow DOM panel
            └─ sandboxed local DSH Web iframe
                    ↕ exact-origin MessageChannel
Local DSH host plugin
  ├─ Vite multi-target broker
  ├─ provider-neutral target/grant/capability registry
  ├─ turn-scoped browser tools
  └─ existing Chrome extension bridge
                    ↕
DSH agent runtime
```

仓库新增或扩展以下单元：

- `packages/vite-plugin`：Vite dev/build 注入、虚拟配置模块、HTML 多入口处理和
  HMR 通知接入。
- `packages/page-runtime`：本地 DSH 探测、页面传输、DOM 工具执行器、元素引用、
  console 缓冲和 Shadow DOM 面板。
- `packages/dsh-plugin`：新增 Vite target broker、页面发现接口、Vite grant、
  `@开发页面` 和 `@当前开发页`；保留现有 Chrome provider。
- `packages/protocol`：保留现有 Extension wire protocol；新增独立版本的 Vite
  页面协议，并抽取共用的工具语义、capability 与错误码。

Host 内部使用 provider-neutral 的 `BrowserTargetDescriptor`：

```ts
interface BrowserTargetDescriptor {
  targetId: string
  provider: 'chrome-extension' | 'vite'
  title: string
  url: string
  capabilities: BrowserCapability[]
}
```

Chrome 的 `tabId/windowId` 和 Vite 的页面连接身份均留在 provider 内部。它们
不会进入模型工具参数，也不会被另一种 provider 伪造。

## 6. Vite 插件配置

```ts
import { dshBrowserBridge } from '@ycp424c/dsh-browser-bridge-vite'

export default defineConfig({
  plugins: [
    dshBrowserBridge({
      dshOrigin: 'http://127.0.0.1:3080',
      bridge: {
        enabled: true,
        injectInBuild: false,
        autoConnectInBuild: false,
      },
      panel: {
        enabled: true,
        visible: false,
        shortcut: 'Alt+Shift+D',
        queryParameter: 'dsh',
      },
    }),
  ],
})
```

配置语义：

- `bridge.enabled: false` 完全关闭注入和页面 bridge。
- `bridge.injectInBuild: false` 是默认值；只有显式设为 `true` 才进入生产构建。
- 开发环境默认自动连接本地 DSH。
- 生产环境即使已注入，也默认休眠且不产生本地网络请求。快捷键、`?dsh=1`
  或本地持久化开关可以激活；`autoConnectInBuild: true` 才允许每个访问者主动
  探测并连接本地 DSH。
- `panel.enabled: false` 只关闭嵌入 UI，bridge 仍可在激活后从独立 DSH Web
  的 `@开发页面` 使用。
- `panel.visible: false` 默认隐藏入口；激活方式仍由注入 bootstrap 处理。
- `panel.visible: true` 触发一次低权限健康探测，但只有探测成功才显示入口；
  它不会在用户打开面板或显式激活 bridge 前注册 target。部署方必须被告知该
  配置会让每个访问者产生一次回环探测。
- 插件不扫描端口，只访问配置的精确 origin。
- 所有配置都会进入前端产物，因此 schema 拒绝凭证字段，并在文档中明确禁止
  放入秘密。

`dshOrigin` 只接受下列 HTTP(S) 回环 host：

- `localhost` 与 `*.localhost`
- `127.0.0.0/8`
- `::1`

配置解析拒绝带用户名或密码的 URL、非 HTTP(S) scheme、非回环 host，以及
探测过程中的非回环重定向。

插件使用 Vite 的 `transformIndexHtml` 在 dev 和显式启用的 build 中注入 Runtime，
并覆盖多 HTML entry。生产默认不注入，SSR 生成的非 Vite HTML 与 library mode
不在首版范围内。

参考：[Vite Plugin API](https://vite.dev/guide/api-plugin.html)。

## 7. 页面注册与发现

Runtime 激活后连接本地 DSH 的独立、多目标 WebSocket broker。首帧包含协议版本，
随后注册：

- 随页面生命周期生成的 `targetId`
- 当前 URL、标题和净化后的 Vite 项目标识
- `provider: 'vite'`
- capability 列表
- 页面 generation

`targetId` 可存放在 `sessionStorage`，使同一标签页刷新后保持逻辑身份。它只是
关联标识，不是 authority。Host 为每个 WebSocket 分配 connection identity；
同一 `targetId` 出现并发冲突时，Host 拒绝或重新分配，不允许新连接静默接管
仍存活的目标。

页面协议只接受以下方向和类型：

- 页面到 Host：`hello`、`target.register`、`target.update`、`tool.accepted`、
  `tool.result`、`ping/pong`。
- Host 到页面：注册结果、`tool.call`、target revoke、`ping/pong` 和稳定错误。

页面不能通过该协议创建 grant、调用 DSH 文件系统、执行命令、读取其他页面，
或访问任何宿主插件 API。

DSH Web 提供两个引用入口：

- `@开发页面`：从本地 Host 回读所有当前连接的 Vite target，可一次附加多个。
- `@当前开发页`：仅当 DSH Web 嵌在目标页面中时出现，指向承载当前面板的
  target。

父页面只通过一次性 `MessageChannel` 发送非敏感 `targetId`。DSH client plugin
必须向 Host 回读连接、URL 和 capability；不能信任父页面自报的标题、URL 或
权限。

## 8. Prompt-scoped grant

选择页面只创建 composer reference，不立即赋予模型权限。发送 prompt 时：

1. DSH client plugin 向同源的本地 Host 请求一次性 grant。
2. Host 将 grant 绑定到 DSH session、turn、provider、逻辑 target 身份
   （精确 `targetId` + origin）、当前 connection 和到期时间。恢复窗口内的
   合法重连可以把同一逻辑 target 重新绑定到新 connection；其他 connection
   不能继承 grant。
3. Client 只向 prompt 序列化一次性关联 marker；连接凭证与 grant authority
   不进入消息文本。
4. `agent/pre-step` 消费 marker，回读 target，生成 `page_1`、`page_2` 等别名，
   并注入净化后的 URL、标题与 capability 摘要。
5. Host 仅为本轮有效页面注册工具。工具闭包持有已验证 grant，模型不能通过
   构造 `targetId`、provider 或 alias 扩权。

工具链如下：

```text
DSH tool
  → host validates turn grant
  → Vite target broker
  → exact page WebSocket
  → page runtime executor
  → bounded and sanitized result
  → DSH
```

以下事件撤销 grant：

- turn 完成、取消或从队列移除
- grant 超时
- 页面关闭
- 页面超过有界恢复窗口仍未重连
- 页面跳转到不同 origin
- Host 或 target session 终止

HMR 和同源刷新可在有界窗口内恢复当前 turn，但必须递增 generation 并清空
全部元素引用。重连后的读取操作最多自动重试一次；点击、输入、选择、导航等
写操作永远不自动重放。

## 9. 工具 API 与 capability

Vite provider 复用现有 `browser_*` 工具名，但只声明能够可靠实现的 capability。

### 9.1 首版支持

- `browser_observe`：从 DOM、ARIA、表单和可交互元素生成有界语义树、页面身份、
  viewport 与短生命周期引用。它不是浏览器原生 Accessibility Tree。
- `browser_inspect`：读取属性、文本、选定的计算样式、边界矩形、可见性和连接
  状态。
- `browser_act`：click、type、select、focus、press、scroll，以及合成的
  pointer/mouse hover 事件。受控输入通过原生 value setter 配合 input/change
  事件兼容 React/Vue。
- `browser_navigate`：同源 URL、前进、后退和刷新。Vite MVP 不延续跨 origin
  写权限。
- `browser_wait`：等待元素、文本、URL、DOM 稳定窗口或下一次 HMR generation。
- `browser_console`：捕获 Runtime 注入后的 console、`window.error` 和
  `unhandledrejection`，使用有界缓冲并携带 generation。

页面 JavaScript 不能生成 `isTrusted === true` 的输入，也不能可靠强制浏览器
CSS `:hover` 状态。`browser_act` 的 hover 只表示合成 pointer/mouse 事件；若
任务要求验证原生 hover pseudo-state、trusted input 或浏览器 UI，返回
`unsupported_operation`，建议改用 Chrome Extension。

### 9.2 首版不支持

- `browser_screenshot`
- `browser_network`
- 跨域 iframe 内部元素
- 下载、文件选择器、权限弹窗
- 浏览器设置和浏览器 UI
- 必须依赖 trusted input 或原生 CSS pseudo-state 的操作

这些能力不使用 html2canvas、fetch/XHR monkey patch 等不完整模拟。调用时返回
稳定的 `unsupported_operation`。

混合附加 Chrome 与 Vite 页面时，turn 工具集合取页面 capability 并集；注入上下文
明确列出每个 `page_n` 的能力。不支持某项能力的 target 返回稳定 capability
错误，不将调用转发到其他页面，也不猜测替代行为。

敏感值规则沿用 Extension 的保守边界：password、卡号、token、secret、PIN、
API key 等输入值不得出现在 observe、inspect、console 或正常日志中。所有输出
具有节点数、字符数、记录数和单条消息大小上限。

## 10. HMR 与页面 generation

开发环境 Runtime 使用 Vite HMR API 监听 `vite:afterUpdate`：

1. HMR 完成后递增 generation。
2. 清空全部元素引用。
3. 使用 MutationObserver 等待有界的 DOM 静默窗口。
4. 向 Host 报告 target 已更新。
5. 唤醒等待下一 generation 或 DOM 稳定的 `browser_wait`。

每个元素引用同时绑定 target、generation 和内部引用记录，并在使用时检查
`element.isConnected`。HMR、同源刷新、导航或 DOM 替换后返回 `stale_element`，
不猜测相似元素。

console 缓冲不会因普通 HMR 清空，但记录 generation；grant 结束、target 终止
或 Runtime 卸载时清除。生产构建没有 HMR capability。

首版不向模型暴露绝对源码路径、组件树或 HMR module graph。

参考：[Vite HMR API](https://vite.dev/guide/api-hmr.html)。

## 11. 可选侧栏

面板在独立 Shadow Root 中渲染，避免目标应用 CSS 污染 launcher、遮罩、抽屉
和诊断 UI。面板 iframe：

- 只加载配置的精确回环 DSH origin。
- 使用与现有 Extension 面板一致的最小 sandbox capability。
- 通过一次性 `MessageChannel` 通信，同时校验初始 `event.source` 和精确 origin。
- 不使用 `postMessage('*')`。
- 只接收当前 target 的非敏感标识；权限由 Host 回读和 grant 决定。

iframe 加载普通的完整 DSH Web，不发明新的会话 deep-link，也不自动选择会话。
用户通过 DSH Web 原有会话界面打开已有开发对话；因此“延续已有对话”依赖的是
完整 DSH Web 的既有会话能力，而不是 Vite provider 新增会话存储或路由。

面板加载失败不等于 bridge 失败。Runtime 分别报告 panel 与 target connection
状态。CSP、`frame-ancestors` 或本地网络限制阻止 iframe 时，面板显示具体诊断，
并提供在新标签页打开精确本地 DSH Web 的降级入口。

关闭面板不撤销正在执行的 turn；关闭页面、卸载 Runtime 或 target 连接终止才
触发对应清理。

## 12. 生产构建与安全

生产模式将“代码被注入”“本地健康探测”和“target 已连接”分开：

- `injectInBuild: true` 只表示构建产物包含 Runtime。
- 默认 `autoConnectInBuild: false` 且 `panel.visible: false` 时，Runtime 完全
  休眠，不探测也不连接本地网络。
- 快捷键、查询参数或本地持久化开关会先执行一次健康探测；成功后连接 broker、
  注册 target，并在启用面板时打开面板。
- `panel.visible: true` 只主动执行健康探测；成功后显示 launcher，直到用户打开
  面板或显式激活 bridge 才连接 broker 和注册 target。
- `autoConnectInBuild: true` 主动执行健康探测并在成功后直接连接、注册 target。
- `panel.visible: true` 和 `autoConnectInBuild: true` 都是明确的部署方选择，文档
  必须说明每个访问者会产生回环请求；后者还会让每个成功探测的页面注册 target。

本地 Host 的 Vite broker 是低权限、多 target 接口：

- 页面注册内容和页面证据均视为不可信输入。
- 未经用户显式 `@` 的 target 不进入模型上下文。
- 页面连接不能调用 Host 能力。
- Host 首版默认限制为最多 32 个 Vite target、每个页面 origin 最多 8 个 target、
  单帧 1 MiB、每个 target 同时 4 个工具调用、每秒 16 个非心跳帧；心跳间隔
  15 秒，连续 45 秒未收到有效帧即断开。实现计划和测试使用这些默认值，不以
  “后续再定”替代资源边界。
- Host 清洗 URL、标题、项目标识、console 和错误文本。
- 页面 origin 会被记录并与 URL origin、连接 identity 和 target grant 交叉校验。

规范层面，回环地址属于 potentially trustworthy origin；这只是设计依据，不是
运行时兼容性保证。必须用真实 HTTPS fixture 验证 HTTPS 生产页面访问本地
HTTP/WS DSH，并覆盖当前支持的 Chrome 与 Arc。

参考：[Secure Contexts: Is origin potentially trustworthy?](https://w3c.github.io/webappsec-secure-contexts/#is-origin-trustworthy)。

生产站点若设置 CSP，需要部署方在响应头中允许所选回环来源，例如：

```text
frame-src   http://127.0.0.1:* http://localhost:*;
connect-src http://127.0.0.1:* http://localhost:*
            ws://127.0.0.1:* ws://localhost:*;
```

配置 HTTPS/WSS 本地 DSH 时加入对应来源。Vite 插件不能放宽服务器响应头中的
CSP，只能给出构建提示、文档和运行时诊断。浏览器本地网络权限、CSP、
`frame-ancestors` 或混合内容策略阻止访问时不得静默失败。

首版默认无遥测。页面 metadata、页面证据、grant 和 console 不持久化到插件
存储；仅用户显式的本地激活开关可以写入约定的 localStorage key。

## 13. 可靠性与错误处理

新增或复用稳定错误码：

- `dsh_unavailable`：配置的本地 DSH 未运行或健康检查失败。
- `local_access_blocked`：浏览器阻止本地网络或回环访问。
- `embedding_blocked`：CSP、`frame-ancestors` 或 iframe 策略阻止面板。
- `target_disconnected`：目标页面连接丢失且未在恢复窗口内重连。
- `unsupported_operation`：provider 不支持请求的 capability。
- `stale_element`：generation、导航或 DOM 替换使引用失效。
- `grant_expired`：当前 prompt grant 不存在、已撤销或已过期。
- `navigation_requires_confirmation`：操作将跨 origin 或页面意外跨 origin。
- `protocol_mismatch`：页面 Runtime 与 Host 页面协议版本不兼容。
- `timeout`：探测、连接、工具或等待超过有界时间。

探测和只读重连使用有上限的指数退避，不扫描其他端口。Mutating operation 收到
`tool.accepted` 后无论连接是否中断都不自动重发。取消信号从 DSH turn 传播到
Host pending call 和页面执行器；重复取消、revoke、断开和 Runtime unload 必须
幂等。

协议版本不兼容时显示双方版本和升级方向，但不回显收到的原始 payload。页面
返回的数据必须先经过 schema 校验、大小限制和敏感值清洗，失败时返回稳定错误。

## 14. 测试策略

### 14.1 单元测试

- 回环 origin 和配置解析，包括 IPv4、IPv6、`*.localhost`、credentials 与重定向。
- DOM/ARIA 语义投影、敏感值遮罩、输出上限。
- 元素引用、generation、`isConnected` 与 stale 映射。
- capability 合并、工具注册和 `unsupported_operation`。
- console 包装不改变原始 console 行为，缓冲有界且可清理。

### 14.2 协议与 Host 测试

- 多页面注册、并发 target、targetId 冲突与 connection identity。
- grant 创建、消费、turn 绑定、超时、revoke 和跨 target 拒绝。
- 重连、取消、读取单次重试、写入不重放。
- 畸形帧、未知版本、超大消息、频率限制和资源清理。
- 页面不能创建 grant 或调用 Host/文件/命令 API。
- 现有 Extension wire protocol 和测试保持通过。

### 14.3 浏览器集成测试

使用 Vanilla、React 和 Vue fixture 覆盖：

- observe、inspect、click、受控输入、select、focus、press、scroll。
- 合成 hover 的明确语义与原生 CSS hover 的不支持结果。
- 同源导航、刷新、HMR、DOM 替换与 stale refs。
- console、`window.error`、`unhandledrejection` 和 generation。
- 多页面、独立 DSH Web 与嵌入面板。

### 14.4 Vite 构建测试

- dev 默认注入和连接。
- build 默认不注入。
- `injectInBuild: true` 显式注入且默认休眠。
- 多 HTML entry。
- `panel.enabled: false` 不注入 UI，但保留可激活 bridge。
- 非 HTML/library/SSR 边界按首版非目标处理，不产生隐式注入。

### 14.5 生产与安全测试

- 真实 HTTPS fixture 访问回环 HTTP/WS DSH。
- CSP、`frame-ancestors`、本地网络限制的诊断路径。
- 非回环 origin 与非回环重定向拒绝。
- 普通未激活访问不探测本地网络。
- 未附加页面没有模型工具；页面不能调用 Host 权限。

### 14.6 DSH 端到端与浏览器门禁

用确定性工具调用覆盖嵌入与独立 DSH Web 的 attach、tools、HMR、revoke 和多页
流程。真实 LLM 行为作为人工 smoke，不作为非确定性 CI 门禁。

Chromium 自动化是持续集成基线；Chrome 与 Arc 必须完成真实人工验收。Arc 验收
是首版发布门禁，不因 Chromium 测试通过而省略。

## 15. MVP 验收标准

1. 不修改 DSH 源码，现有 Chrome Extension protocol 与功能保持兼容。
2. Vite 开发页面可以直接打开嵌入的完整本地 DSH Web。
3. `panel.enabled: false` 时，页面仍可从独立 DSH Web 的 `@开发页面` 附加。
4. 生产构建默认不注入；显式注入后默认休眠，且只连接本地回环 DSH。
5. `panel.visible: true` 只执行健康探测并在成功后显示入口；打开面板或显式激活
   前不得注册 target。默认隐藏配置不得产生本地网络请求。
6. `@当前开发页` 和 `@开发页面` 都生成 prompt-scoped grant；没有引用就没有工具。
7. 同一开发对话可 observe、inspect、act、navigate、wait、读取有限 console，
   并在 HMR 后继续修改和复验。
8. 多个页面获得稳定 `page_n` 别名、独立 grant 和明确 capability。
9. Vite-only turn 不把 screenshot/network 宣称为可用能力；相关调用返回稳定错误。
10. HMR 与 DOM 替换使旧引用可靠失效，断线不会导致写操作重复执行。
11. turn 完成、取消、移除、超时、页面离开和跨 origin 跳转都会撤销授权。
12. HTTPS 生产 fixture、Chrome 人工验收和 Arc 人工验收全部通过。

## 16. 实施阶段

### 阶段一：Provider 抽象

在不改变现有 Extension wire protocol 的前提下，引入 provider-neutral target、
grant、capability 模型和 Vite 页面协议，完成多 target broker 与协议测试。

### 阶段二：Page Runtime

完成页面注册、直连、DOM 工具、console、元素引用、generation、重连、取消与
清理，并用 Vanilla/React/Vue fixture 验证。

### 阶段三：Vite Plugin 与面板

完成 dev/build 注入、多入口、配置 schema、Shadow DOM 面板、DSH Web iframe、
`@开发页面` 与 `@当前开发页`。

### 阶段四：生产边界

完成休眠激活、本地探测、回环校验、CSP/本地网络诊断、资源限制和真实 HTTPS
fixture。

### 阶段五：完整验收与文档

完成全量回归、Chrome/Arc 人工门禁、安装与使用说明、provider 能力对比、升级
说明和录屏场景。

每个阶段必须在前一阶段验证通过后进入下一阶段；不能用后续 UI 集成掩盖前一阶段
协议或权限边界未完成。

## 17. 实现边界

首版只修改 `dsh-browser-bridge` 仓库，使用公开 DSH plugin extension points，
不修改 DSH 源码。若实现中发现外部插件无法完成某个已确认能力，必须提供最小
复现、记录具体 DSH 限制，并单独评审是否调整范围；不能静默扩展到 DSH 源码。

本设计完成后先生成详细 implementation plan，再开始编码。实现计划必须逐阶段
列出文件、测试、兼容迁移和验证命令，并保留用户对生产注入、显式 grant 和本地
DSH-only 的全部边界。
