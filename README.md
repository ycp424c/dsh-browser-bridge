# dsh-browser-bridge

An explicit-context browser bridge: DSH gains structured, turn-scoped access
to Chrome tabs that the user explicitly attaches to an individual prompt. It
is a general-purpose bridge — debugging, issue reproduction, information
extraction, form operations, and lightweight browser automation all use the
same primitives — not a validation-only tool and not browser-wide Computer
Use.

The primary product scenario is the development feedback loop:

1. DSH changes source code with its existing filesystem and shell tools.
2. The development server or HMR updates the page already open in Chrome.
3. The user attaches that page with `@当前标签页`.
4. DSH observes the exact page, interacts with it, and verifies structured
   browser facts: DOM state, computed styles, geometry, exact URL, console
   errors, and failed requests.
5. DSH continues editing and validating until the result is reached.

## Architecture

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

Three units share one transport-neutral protocol package
(`packages/protocol`):

- `extension/` — a Manifest V3 side-panel extension (React + shadcn shell)
  that owns tab discovery, prompt grants, and `chrome.debugger` sessions.
- `packages/dsh-plugin/` — one external DSH plugin with a client half
  (composer integration) and a host half (pairing, grants, tools).
- `packages/protocol/` — versioned wire schemas shared by both.

## Attaching tabs to a prompt

- The `@当前标签页` button next to the composer attaches the current Chrome
  tab to the prompt in one click.
- The `@` reference source (`browser-tabs`) lists eligible tabs and can
  attach more than one; each attached page gets a stable alias such as
  `page_1`, `page_2` plus sanitized title/URL metadata in the prompt.
- Grants are per-prompt: they expire when the turn completes, is cancelled,
  or is removed from a queue; when the tab closes; or when the bridge
  disconnects. The next prompt must attach tabs again.
- A popup or newly opened tab is never authorized implicitly, and changing
  the active tab after sending does not retarget the grant.

## Browser tools

While a prompt has at least one valid grant, these tools exist for that turn
only: `browser_observe`, `browser_inspect`, `browser_screenshot`,
`browser_act`, `browser_navigate`, `browser_wait`, `browser_console`, and
`browser_network`. Element references are short-lived; a navigation
invalidates them and tools return `stale_element` rather than guessing.

Console and network evidence is bounded, starts when the debugger attaches,
and is deleted with the grant: no headers, bodies, cookies, or password
values are ever returned.

## Permissions and boundaries

- `debugger` — CDP sessions; attached lazily on the first tool call and
  detached when the grant ends. Opening DevTools detaches the session and
  returns the recoverable `debugger_detached` error.
- `tabs` — tab titles/URLs for `@` references. No ambient browsing history
  is recorded.
- `storage` — local settings and a non-secret ownership ledger in
  `chrome.storage.session` for service-worker startup reconciliation.

Only HTTP(S) tabs are attachable. The first release supports local DSH Web
origins (`localhost`, `127.0.0.1`) and Chrome 118+. Raw CDP
passthrough is disabled by default, incognito tabs are unsupported, there is
no telemetry by default, and no access carries implicitly into future
prompts. If DSH Web cannot be framed, the side panel shows an actionable
embedding diagnostic.

Unexpected cross-origin navigation suspends further writes
(`navigation_requires_confirmation`) until a new prompt explicitly attaches
the new page; reads remain available.

## Installing and running

See [INSTALL.md](INSTALL.md) for the executable checklist: local DSH link,
frozen install, `pnpm check`, plugin profile install, unpacked extension
loading, updating, uninstalling, and per-error troubleshooting.

## Design documents

- [Approved design](docs/superpowers/specs/2026-08-10-dsh-browser-bridge-design.md)
- [Implementation plan](docs/superpowers/plans/2026-08-10-dsh-browser-bridge.md)
