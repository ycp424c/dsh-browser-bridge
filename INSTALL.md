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
- `extension/.output/chrome-mv3/manifest.json`

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
pnpm --filter @dsh-external/dsh-browser-bridge build
dsh plugin --profile web add /absolute/path/to/dsh-browser-bridge/packages/dsh-plugin
dsh web
```

The profile installs the **directory** `packages/dsh-plugin` (which contains
`dsh.plugin.json`), not the source checkout root.

## 5. Load the extension

1. Build the extension and zip it for distribution:
   ```bash
   pnpm --filter @dsh-external/dsh-browser-bridge-extension build
   pnpm --filter @dsh-external/dsh-browser-bridge-extension zip
   ```
   The zip is written under `extension/.output/`.
2. Open `chrome://extensions`, enable **Developer mode**, and choose
   **Load unpacked** with `extension/.output/chrome-mv3` (the WXT build
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
  `dsh plugin --profile web remove @dsh-external/dsh-browser-bridge`.
- Remove the extension from `chrome://extensions`. Chrome detaches any
  debugger sessions owned by the extension and closes its side panel.
- To drop the local link: delete the `.dsh/source` symlink.

## Troubleshooting

| Symptom | Likely cause and action |
| --- | --- |
| Side panel shows "DSH Web did not respond" | DSH Web is offline, or its server blocks framing (`X-Frame-Options`/CSP `frame-ancestors`). Start `dsh web`, retry, or edit the origin. |
| `bridge_disconnected` | The extension is not paired with DSH Web. Reload the side panel and DSH Web; the client re-pairs with a fresh nonce. |
| `grant_expired` | The turn ended or the grant deadline passed. Attach the tab again in a new prompt. |
| `tab_closed` | The attached tab was closed. Attach the current tab again. |
| `unsupported_page` | The tab is a Chrome-protected, incognito, or otherwise unsupported page. |
| `debugger_busy` | Another debugger (for example DevTools) is attached to the tab. Close DevTools and retry. |
| `debugger_detached` | The CDP session detached (for example DevTools was opened while attached). Close DevTools and retry; re-attach in a new prompt if needed. |
| `navigation_requires_confirmation` | The page navigated to an unexpected origin. Reads stay available; attach the new page explicitly in a new prompt to write again. |
| `stale_element` | The document navigated or the element was replaced. Re-observe to get fresh references. |
| `timeout` | The operation exceeded its budget. Retry, or check the page for long-running work. |
| `protocol_mismatch` | The extension and host plugin speak different protocol versions. Update both from the same build. |
