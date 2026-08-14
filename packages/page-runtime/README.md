# @ycp424c/dsh-browser-bridge-page-runtime

Framework-neutral browser runtime injected into Vite pages by the DSH
browser bridge. It probes and connects to the exact loopback DSH origin,
registers one target, executes the reliable tool subset
(`observe`/`inspect`/`act`/`navigate`/`wait`/`console`) against the real
page, tracks HMR generations, captures a bounded console buffer, and hosts
the optional Shadow DOM DSH Web panel.

- Only loopback DSH origins are accepted (`localhost`, `*.localhost`,
  `127/8`, `::1`); no credentials, no remote DSH, no port scanning.
- Production default is zero-network dormancy; activation is explicit
  (shortcut, query parameter, persisted switch) or an explicit deployment
  choice (`autoConnectInBuild` / `panel.visible`).
- Sensitive values are masked and every output is bounded before
  serialization; the host re-sanitizes everything after the wire.
- Page identity lives in per-tab `sessionStorage`; grants, console rows, and
  page evidence are never persisted to localStorage.
- Screenshot and network are never registered by this runtime; related calls
  return `unsupported_operation`.

See the workspace [README](../../README.md) and
[INSTALL.md](../../INSTALL.md) for installation and configuration.
