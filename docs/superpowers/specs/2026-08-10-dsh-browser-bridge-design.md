# DSH Browser Bridge Design

Date: 2026-08-10
Status: Approved for implementation planning

## 1. Summary

`dsh-browser-bridge` connects DSH to Chrome tabs that the user explicitly
attaches to an individual prompt. The Chrome side panel embeds DSH Web, while a
Chrome extension and an external DSH plugin cooperate to expose prompt-scoped,
structured browser tools.

The first-class product scenario is the development feedback loop:

1. DSH changes source code with its existing filesystem and shell tools.
2. The existing development server or HMR updates the page already open in the
   user's Chrome profile.
3. The user adds that page to the prompt with `@当前标签页`.
4. DSH observes the exact page, interacts with it, and verifies structured
   browser facts such as DOM state, computed styles, geometry, URL, console
   errors, and failed requests.
5. DSH continues editing and validating until the requested result is reached.

The bridge is intentionally not named or designed as a validation-only tool.
The same primitives support debugging, issue reproduction, information
extraction, form operations, and lightweight browser automation.

## 2. Goals

- Embed the normal DSH Web experience in a Chrome side panel instead of
  implementing another chat client.
- Let every prompt explicitly declare which Chrome tabs DSH may read and write.
- Provide a convenient `@当前标签页` composer shortcut and an `@` reference
  source that can attach more than one tab.
- Preserve the user's actual Chrome session, cookies, login state, viewport,
  runtime state, and current application page.
- Keep DSH itself unchanged by implementing the integration as an external DSH
  plugin plus a Chrome extension.
- Use CDP as the single browser-control transport while exposing stable,
  model-friendly structured tools.
- Revoke browser access automatically when the corresponding DSH turn ends.

## 3. Non-goals

- Replacing `dsh-browser` or evolving its custom browser-assistant chat UI.
- Owning a separate Playwright or Chromium process.
- Providing OS-level computer use or controlling Chrome's own UI.
- Giving DSH ambient access to every tab or carrying grants implicitly between
  prompts.
- Exposing raw CDP to the model by default.
- Supporting downloads, uploads, clipboard access, browser settings, extension
  management, incognito tabs, or Chrome-protected pages in the first release.
- Modifying DSH source code to add a new attachment primitive or response-header
  hook.

## 4. Considered approaches

### 4.1 Chrome extension plus two-sided DSH plugin — selected

The extension side panel embeds DSH Web. The client half of the DSH plugin owns
composer integration and parent-frame communication. The host half owns grants,
turn lifecycle, structured tools, and the authenticated bridge endpoint. The
extension service worker owns Chrome permissions and CDP sessions.

This preserves the complete DSH experience, avoids DSH source changes, and
keeps browser authority in Chrome.

### 4.2 Separate DSH Web tab plus a bridge-only extension

This has a smaller UI surface but separates the conversation from the target
page and loses the intended side-panel experience.

### 4.3 A new chat UI inside the extension

This duplicates DSH conversation, streaming, model, and plugin behavior and
would recreate the maintenance burden of `dsh-browser`.

### 4.4 Content-script-first browser control

Content scripts are straightforward for basic DOM access and synthetic events,
but console, network, accessibility, screenshots, and richer debugging require
additional channels. A later CDP layer would create two control paths.

### 4.5 Raw CDP passthrough

A generic `sendCommand(method, params)` tool minimizes extension code, but it
forces the model to manage low-level node identifiers, frames, execution
contexts, coordinates, navigation invalidation, and CDP event sequencing. This
moves complexity into every inference and is less reliable than a thin
structured API.

## 5. Architecture

```text
Chrome side panel
  └─ embedded DSH Web
       └─ DSH client plugin
            ├─ @ tab references and shortcut
            └─ origin-checked postMessage
                    ↕
Chrome extension service worker
  ├─ DSH bridge connection
  ├─ prompt grant vault
  └─ CDP session manager
                    ↕ authenticated WebSocket
DSH host plugin
  ├─ pairing endpoint
  ├─ grant validation and message sanitization
  ├─ turn-scoped tool registration
  └─ browser tool adapter
                    ↕
DSH agent runtime
```

The repository is a small monorepo with three principal units:

- `extension`: the Manifest V3 side panel, service worker, local settings, grant
  vault, and CDP session manager. Its UI shell uses React and shadcn; it does not
  implement a chat interface.
- `packages/dsh-plugin`: a single installable external DSH plugin with client
  and host entry points.
- `packages/protocol`: transport-neutral schemas for pairing, grants, bridge
  requests, tool results, errors, and version negotiation.

Each unit depends on the protocol package, not on another unit's internals.

## 6. Side panel and pairing

The user configures the DSH Web origin in extension settings. The first release
officially supports a local DSH instance. The extension loads that origin in a
side-panel iframe and accepts messages only from the configured exact origin.

The host plugin exposes a pairing endpoint through DSH's plugin web surface.
The client plugin requests a short-lived pairing nonce from the same DSH origin
and forwards it to the parent extension using an origin-checked `postMessage`.
The extension then initiates an authenticated WebSocket connection to the host
plugin. The bridge endpoint listens on loopback and rejects missing, expired,
replayed, or mismatched pairing credentials.

If DSH Web cannot be framed, the side panel reports an actionable embedding
diagnostic. The first release does not require a DSH source change to relax
response headers.

## 7. Prompt-scoped tab grants

`@当前标签页` is a visible composer reference and a temporary capability grant,
not merely inserted text.

### 7.1 Creating references

- A composer shortcut attaches the current Chrome tab.
- The `@` reference source can list eligible tabs and attach more than one.
- Each chip displays enough identity for the user to detect mistakes: title,
  domain, favicon, and an unambiguous ordinal when necessary.
- Chrome-protected and otherwise unsupported pages are excluded or shown as
  unavailable before the prompt is sent.

### 7.2 Issuing a grant

At send time, the extension creates an unguessable, single-use grant for every
attached chip. A grant is bound to:

- the DSH bridge session;
- the DSH conversation and prompt/turn;
- the exact Chrome `tabId`;
- the URL observed when the grant was issued; and
- an expiry deadline.

The grant secret travels out of band over the authenticated extension/host
bridge. During reference serialization, the client plugin registers a
non-secret, single-use correlation handle with the host plugin and serializes a
safe reference marker. The handle alone grants no authority: the host also
checks bridge session, conversation, turn, tab, and expiry. During
`agent/pre-step`, the host consumes the handle and replaces the marker with a
sanitized page summary before model inference. Grant secrets never enter
message text, model input, model tool arguments, user-visible conversation text,
or normal logs. The model receives stable aliases such as `page_1` plus
sanitized title and URL metadata.

### 7.3 Applying and revoking a grant

The host plugin registers browser tools only for a turn with at least one valid
grant. Tools close over validated capability records; the model cannot supply a
raw `tabId` or token to widen its scope.

Grants expire when the turn completes, is cancelled, or is removed from a
queue; when the referenced tab closes; or when the bridge session terminates.
The next prompt must attach tabs again. A popup or newly opened tab is never
authorized implicitly.

## 8. Browser tool API

DSH sees structured tools whose schemas remain stable even if CDP details
change:

- `browser_observe`: return page identity, lifecycle state, semantic DOM or
  accessibility content, and short-lived element references.
- `browser_inspect`: return requested attributes, text, computed style,
  geometry, and visibility for a referenced element.
- `browser_screenshot`: capture the current viewport or a referenced element and
  return an artifact usable by the user or a vision-capable model.
- `browser_act`: click, type, select, hover, press keys, focus, and scroll using
  an element reference or an explicit selector fallback.
- `browser_navigate`: open an HTTP(S) URL, go back or forward, and reload.
- `browser_wait`: wait for an element, text, URL, lifecycle condition, or bounded
  page stability condition.
- `browser_console`: return console errors and relevant log entries observed
  after the tab was attached.
- `browser_network`: return failed or selected network activity observed after
  the tab was attached.

`browser_observe` generates short-lived references. A document navigation
invalidates them all, and DOM replacement may invalidate individual references.
The tools return `stale_element` rather than guessing another target.

Automated style verification should prefer structured evidence such as
computed CSS properties, bounding rectangles, visibility, DOM state, and exact
URL. Screenshots are supporting evidence and can be interpreted when the active
model supports vision.

An advanced raw-CDP escape hatch may be implemented behind an explicit plugin
configuration flag. It is disabled by default and is not part of MVP acceptance.

## 9. CDP lifecycle

The extension uses `chrome.debugger` as its only browser-control transport.

- A valid grant alone does not attach a debugger.
- The first browser tool call lazily attaches to its target tab and enables only
  the required CDP domains.
- Multiple granted tabs use independent sessions keyed by validated capability,
  never by a model-provided identifier.
- Tool-initiated navigation may continue in the same tab and returns the new
  URL. An unexpected cross-origin transition suspends further writes until the
  user issues a new prompt grant.
- Durable `turn/end` (completed, error, aborted, or disposed), tab closure, or
  terminal bridge loss explicitly releases the corresponding session. Chrome
  grants also use a 10-minute sliding idle lease bounded by an immutable 6-hour
  maximum. A fresh authorized tool request suspends idle expiry while it is in
  flight; after the last fresh call settles, the idle deadline starts again.
  Request ids enter a grant-scoped journal before asynchronous CDP attachment,
  so concurrent, failed, and delayed exact duplicates replay the original
  outcome without execution or renewal; payload-changing reuse fails closed.
  Revocations created during a transient disconnect are flushed before the same
  logical session publishes `connected`. An unexpected service-worker
  interruption is handled by startup reconciliation before new work is accepted.
- Opening Chrome DevTools can detach `chrome.debugger`; this is surfaced as a
  specific recoverable error rather than hidden behind a generic action failure.

While a grant or CDP session is active, the authenticated WebSocket exchanges a
bounded heartbeat frequently enough to keep a supported Manifest V3 service
worker alive. Active session identifiers and owned tab IDs are recorded in
`chrome.storage.session`, without grant secrets or captured page data. On worker
startup, the extension invalidates any interrupted grants and performs
best-effort cleanup of CDP sessions recorded as its own before accepting new
work.

The extension records no ambient browsing history. Console and network buffers
start when CDP attaches and are deleted with the grant.

## 10. Reliability and error handling

The bridge exposes stable error codes with actionable recovery hints:

- `bridge_disconnected`
- `grant_expired`
- `tab_closed`
- `unsupported_page`
- `debugger_busy`
- `debugger_detached`
- `navigation_requires_confirmation`
- `stale_element`
- `timeout`
- `protocol_mismatch`

Manifest V3 service-worker suspension may interrupt a pending call. After
reconnection, the host may retry an idempotent observation operation once.
Mutating operations such as click, type, or navigation are never replayed
automatically because their outcome may already have occurred.

All operations have bounded timeouts. Cancellation propagates from the DSH turn
to the host plugin, bridge request, and CDP operation. Cleanup is idempotent so
that duplicate cancellation or detach events are safe.

## 11. Security and privacy

- No browser tools exist in model scope without an explicit prompt reference.
- Every operation is checked against the server-side validated grant and exact
  tab.
- Pairing credentials and grants are high-entropy, short-lived, single-use, and
  excluded from model input and normal logs.
- The iframe and parent validate exact message source and origin.
- The bridge is authenticated and exposed only through the configured local DSH
  instance.
- CDP attaches lazily and detaches at turn end.
- Sensitive input values are masked by default in observations. Tools do not
  return password values.
- Extension storage contains settings and non-secret connection metadata, not
  captured page content.
- The first release has no telemetry by default.

The required Chrome `debugger` permission is explained during installation and
on first use. The product does not imply that prompt-scoped application consent
is equivalent to blanket browser permission.

## 12. Testing strategy

### 12.1 Unit tests

Cover grant issuance and expiry, exact-tab binding, envelope stripping,
read/write classification, CDP command translation, node invalidation, error
mapping, retry rules, protocol versioning, and idempotent cleanup.

### 12.2 Protocol tests

Use deterministic fake peers to cover client-plugin/host-plugin pairing,
extension authentication, request correlation, cancellation, timeout,
reconnection, malformed messages, replay rejection, and version mismatch.

### 12.3 Chrome integration tests

Launch headed Chromium with the unpacked extension and deterministic fixture
pages. Exercise debugger attach/detach, DOM and CSS observation, interaction,
screenshot capture, navigation, console and network capture, multiple tabs,
service-worker restart, and the DevTools-detach path where automation permits.

### 12.4 DSH end-to-end tests

Run DSH with the external plugin, load DSH Web in the side panel, attach fixture
tabs, and drive deterministic tool calls through the agent runtime. Actual LLM
behavior remains a manual smoke test rather than a nondeterministic CI gate.

## 13. MVP acceptance criteria

1. The side panel embeds the configured local DSH Web without implementing a
   separate chat client.
2. Without an attached tab reference, no browser tools are registered and CDP
   never attaches.
3. `@当前标签页` and the `@` tab list can attach one or more exact tabs to a
   single prompt.
4. DSH cannot operate a tab not named by the prompt, including an active tab
   that changes after sending.
5. DSH can observe semantic page state, inspect computed style and geometry,
   interact with common controls, navigate, wait, capture screenshots, and read
   console errors and failed network requests.
6. A fixture CSS edit followed by HMR can be verified against the same real tab
   using exact URL, computed style, layout, and screenshot evidence.
7. Navigation invalidates stale element references, and an unexpected
   cross-origin transition prevents further writes.
8. Lost responses never cause mutating operations to be replayed automatically.
9. Turn completion, cancellation, expiry, tab closure, and bridge loss revoke
   the grant and detach CDP.
10. DevTools contention, protected pages, expired grants, and closed tabs return
    stable, actionable errors.

## 14. Implementation boundary

The initial implementation changes only this new repository. It consumes public
DSH plugin extension points and does not modify DSH source. If plugin-only
integration later proves blocked by a concrete DSH limitation, that limitation
must be documented with a reproducer and reviewed separately rather than
silently expanding scope.
