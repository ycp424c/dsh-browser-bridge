# @dsh-external/dsh-browser-bridge

External DSH plugin (host + client) for the DSH browser bridge. The host
half owns the Chrome extension bridge (pairing, grants, turn-scoped tools)
and the provider-neutral Vite target broker (health/targets/grants routes
and the page WebSocket); the client half registers the `browser-tabs` and
`vite-pages` `@` sources plus the current-tab and current-dev-page buttons.
See the workspace [README](../../README.md) for the product and
[INSTALL.md](../../INSTALL.md) for installation.
