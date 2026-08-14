# Installing the DSH Browser Bridge

This page is an executable smoke checklist for setting up a local development
installation. It distinguishes the **DSH source checkout** (the local DSH
codebase this plugin links against) from the **installed plugin directory**
(the built `packages/dsh-plugin` folder that `dsh plugin` loads).

## Prerequisites

- Node.js `^22.19.0 || >=24.0.0` and Corepack enabled (`corepack enable`).
- pnpm 11.7.0 (pinned by `packageManager` in the root `package.json`).
- A local checkout of DSH (any checkout whose layout contains `AGENTS.md`,
  `packages/client/runtime`, and `vendor/cordis`).
- Chrome 118+ for the extension.

## 1. Development link

The DSH plugin package imports DSH runtime packages through a symlink created
by the workspace linker. The linker validates the checkout and refuses to
overwrite a different existing link:

```bash
pnpm link:dsh -- /absolute/path/to/dsh
```

Expected: prints `.../.dsh/source/current -> /absolute/path/to/dsh`.

## 2. Install and verify the workspace

```bash
pnpm install --frozen-lockfile
pnpm check
```

`pnpm check` runs typecheck, the unit test suites (protocol, host plugin,
extension), and all builds. Expected artifacts:

- `packages/protocol/lib/index.js`
- `packages/dsh-plugin/lib/index.js`
- `packages/dsh-plugin/lib/client.js`
- `extension/output/chrome-mv3/manifest.json`

## 3. Run the automated Chrome coverage (optional)

The unpacked-extension suite launches Chromium with the extension and a
deterministic fixture server. Browsers are cached inside the repository
(gitignored) so nothing is written to `~/Library`:

```bash
PLAYWRIGHT_BROWSERS_PATH="$PWD/.pw-browsers" pnpm exec playwright test e2e/extension.spec.ts
```

`HEADED=1` forces a visible browser window. On Linux CI, run headed under
Xvfb (see `.github/workflows/ci.yml`).

## 4. Install the plugin into DSH

```bash
pnpm --filter @ycp424c/dsh-browser-bridge build
dsh plugin --profile web add /absolute/path/to/dsh-browser-bridge/packages/dsh-plugin
dsh web
```

The profile installs the **directory** `packages/dsh-plugin` (which contains
`dsh.plugin.json`), not the source checkout root.

## 5. Load the extension

1. Build the extension and zip it for distribution:
   ```bash
   pnpm --filter @ycp424c/dsh-browser-bridge-extension build
   pnpm --filter @ycp424c/dsh-browser-bridge-extension zip
   ```
   The zip is written under `extension/output/`.
2. Open `chrome://extensions`, enable **Developer mode**, and choose
   **Load unpacked** with `extension/output/chrome-mv3` (the WXT build
   output directory).
3. Open the side panel via the toolbar action; the first screen asks for the
   local DSH Web origin (default `http://127.0.0.1:3080`). The panel embeds
   DSH Web in an iframe and shows a connection banner.

The `debugger`, `tabs`, and `storage` permissions are requested at install
time. `debugger` is required for CDP sessions; `tabs` is required to read
tab titles/URLs for `@` references; `storage` keeps the local origin
settings. Only HTTP(S) tabs can be attached; Chrome-protected pages
(`chrome://`, the Web Store, incognito windows) are excluded.

## 6. Update

- After pulling new code, rerun `pnpm install --frozen-lockfile`, `pnpm check`,
  rebuild the extension, and click **Reload** on the extension card in
  `chrome://extensions`.
- After the plugin code changes, rebuild and restart `dsh web` (or reload the
  DSH Web tab). Re-attach tabs in the prompt: grants never carry over between
  turns.

## 7. Uninstall

- Remove the plugin from the DSH profile:
  `dsh plugin --profile web remove @ycp424c/dsh-browser-bridge`.
- Remove the extension from `chrome://extensions`. Chrome detaches any
  debugger sessions owned by the extension and closes its side panel.
- To drop the local link: delete the `.dsh/source` symlink.

## 8. Vite provider（可选）

不安装扩展，把 DSH Browser Bridge 的页面 Runtime 注入到你的 Vite 页面：

```bash
pnpm add -D @ycp424c/dsh-browser-bridge-vite
```

完整的 `vite.config.ts` 示例：

```ts
import { defineConfig } from 'vite'
import { dshBrowserBridge } from '@ycp424c/dsh-browser-bridge-vite'

export default defineConfig({
  plugins: [
    dshBrowserBridge({
      dshOrigin: 'http://127.0.0.1:3080',   // 本地 DSH 的回环 origin
      bridge: {
        enabled: true,
        injectInBuild: false,                 // 生产构建默认不注入
        autoConnectInBuild: false,            // 显式注入后默认休眠
      },
      panel: {
        enabled: true,
        visible: false,
        shortcut: 'Alt+Shift+D',
        queryParameter: 'dsh',
      },
      projectId: 'my-app',
    }),
  ],
})
```

要点：

- 开发服务器默认注入并自动连接本地 DSH；生产构建只有在 `injectInBuild: true` 时注入，且默认零网络请求。
- `dshOrigin` 只接受回环地址（`localhost`、`*.localhost`、`127/8`、`::1`），拒绝凭据与远程地址；所有配置都会进入前端产物，禁止放入秘密。
- `panel.enabled: false` 只关闭嵌入 UI；页面仍可从独立 DSH Web 的 `@开发页面` 附加。
- 面板 iframe 使用最小 sandbox（`allow-scripts allow-same-origin allow-forms allow-popups allow-modals`），仅通过一次性 MessageChannel 通信并校验精确 origin。
- 生产站点设置 CSP 时，需允许所选回环来源：

  ```text
  frame-src   http://127.0.0.1:* http://localhost:*;
  connect-src http://127.0.0.1:* http://localhost:*
              ws://127.0.0.1:* ws://localhost:*;
  ```

### Vite provider 排错

| 错误码 / 症状 | 排查 |
| --- | --- |
| `dsh_unavailable` | 本地 DSH 未运行或健康检查失败：启动 `dsh web`，确认 `dshOrigin` 端口正确。 |
| `local_access_blocked` | 浏览器阻止了本地网络/回环访问（如 CSP `connect-src`、本地网络权限）：允许所选回环来源后重试。 |
| `embedding_blocked` | 面板 iframe 被阻止（CSP `frame-src`、`frame-ancestors`）：面板会显示具体诊断并提供“在新标签页打开本地 DSH”的降级入口；target 连接不受影响。 |
| `target_disconnected` | 页面断线且未在恢复窗口内重连：重新加载页面并重新附加。 |
| `unsupported_operation` | 对 Vite target 调用了截图/network，或请求了 trusted 输入：改用 Chrome Extension 附加该页面。 |
| `stale_element` | HMR、导航或 DOM 替换使引用失效：重新 observe 获取新引用。 |
| `protocol_mismatch` | 页面 Runtime 与 Host 的页面协议版本不一致：更新两者到同一构建。 |
| `timeout` | 探测、连接、工具或等待超过有界时间：重试或收窄请求。 |
| 页面没有任何网络请求 | 生产默认休眠：用快捷键、`?dsh=1` 或本地激活开关激活；或显式设置 `autoConnectInBuild: true`。 |

## Troubleshooting

| Symptom | Likely cause and action |
| --- | --- |
| Side panel shows "DSH Web did not respond" | DSH Web is offline, or its server blocks framing (`X-Frame-Options`/CSP `frame-ancestors`). Start `dsh web`, retry, or edit the origin. |
| `bridge_disconnected` | The extension is not paired with DSH Web. Reload the side panel and DSH Web; the client re-pairs with a fresh nonce. |
| `grant_expired` | The turn ended, the Chrome grant was idle for 10 minutes after its last fresh tool call settled, or its 6-hour absolute cap passed. Attach the tab again in a new prompt. In-flight calls are not idle; exact request replays do not renew. |
| `tab_closed` | The attached tab was closed. Attach the current tab again. |
| `unsupported_page` | The tab is a Chrome-protected, incognito, or otherwise unsupported page. |
| `debugger_busy` | Another debugger (for example DevTools) is attached to the tab. Close DevTools and retry. |
| `debugger_detached` | The CDP session detached (for example DevTools was opened while attached). Close DevTools and retry; re-attach in a new prompt if needed. |
| `navigation_requires_confirmation` | The page navigated to an unexpected origin. Reads stay available; attach the new page explicitly in a new prompt to write again. |
| `stale_element` | The document navigated or the element was replaced. Re-observe to get fresh references. |
| `timeout` | The operation exceeded its budget. Retry, or check the page for long-running work. |
| `protocol_mismatch` | The extension and host plugin speak different protocol versions. Update both from the same build. |
