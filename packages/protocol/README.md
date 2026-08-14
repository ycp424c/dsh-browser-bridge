# @ycp424c/dsh-browser-bridge-protocol

Transport-neutral, versioned wire schemas shared by the Chrome extension and
the external DSH plugin of the DSH browser bridge. See the workspace
[README](../../README.md) for the product and
[INSTALL.md](../../INSTALL.md) for installation.

## Chrome extension protocol (`frames.ts`, version 1)

The authenticated extension/host bridge. `PROTOCOL_VERSION = 1`; every frame
carries the version and a strict discriminant, and unknown fields, unknown
versions, and malformed JSON are rejected without echoing payloads. These
frame shapes are authoritative and must not change.

## Vite page protocol (`vite-frames.ts`, version 1)

A separately versioned page protocol (`VITE_PAGE_PROTOCOL_VERSION = 1`)
between an injected Vite page Runtime and the local DSH host. Direction is
enforced by two distinct unions:

- Page → Host: `hello`, `target.register`, `target.update`, `tool.accepted`,
  `tool.result`, `ping`, `pong`.
- Host → Page: `target.registered`, `tool.call`, `tool.cancel`,
  `target.revoke`, `ping`, `pong`, `error`.

A page can never send `tool.call`, `tool.cancel`, `target.revoke`, or
`error`, and the host can never treat `target.register` as a host-to-page
frame. `tool.call` accepts only the reliable Vite capability subset
(`observe`, `inspect`, `act`, `navigate`, `wait`, `console`); screenshots and
network are never part of the Vite protocol. `tool.cancel` carries only a
correlated request id and a bounded, stable reason code. Every frame is a
strict object, so no frame field can carry a DSH session id, grant handle,
filesystem request, host method, secret, or screenshot/network payload.

## Provider-neutral target descriptors (`targets.ts`)

`BrowserTargetDescriptor` is a strict Zod union discriminated by `provider`:

- `chrome-extension` may advertise the full `BROWSER_OPERATIONS` set.
- `vite` is restricted to `VITE_BROWSER_CAPABILITIES`.

Target ids are opaque 43-character random identifiers; a Vite `targetId` is
only a correlation identity kept in page `sessionStorage`, never an
authority.
