# Vite Provider — Chrome / Arc Manual Acceptance

This document is the exact manual gate for the Vite provider. Chromium
automation (Playwright) is the CI baseline and is NOT a substitute for the
real-browser manual pass described here. Each acceptance row below must be
executed in the real target browser, against a real local DSH instance, and
recorded with evidence.

## Setup

1. Start a real local DSH host (the bridge plugin is loaded via its profile)
   and note the DSH version.
2. Build the fixtures:

   ```bash
   # dev fixture (vanilla / react / vue under e2e/fixtures/vite)
   pnpm exec vite --config e2e/fixtures/vite/vite.config.ts e2e/fixtures/vite/vanilla

   # HTTPS production fixture (injectInBuild + explicit dormancy/autoConnect)
   pnpm exec vite build --config <inline config with dshOrigin=http://127.0.0.1:<dsh port>>
   ```

3. Open the fixtures in the target browser and record the browser version.

## Chrome checklist

- [ ] dev page: the embedded DSH Web panel opens (launcher/drawer visible,
      iframe loads the exact local DSH origin).
- [ ] production HTTPS page: the local DSH probe succeeds and the target
      connects (no extension installed).
- [ ] `@当前开发页`: observe, controlled input (React/Vue), HMR
      invalidation, revoke after turn end.
- [ ] `@开发页面` from standalone DSH Web: attaches a connected Vite page
      and runs observe/act.
- [ ] CSP failure diagnostic: `frame-src`/`connect-src` blocking shows the
      specific diagnostic and the new-tab fallback.

## Arc checklist

- [ ] same four checks as Chrome, without any extension installation;
- [ ] launcher hidden/visible policy (`panel.visible: false/true`);
- [ ] panel close/reopen and standalone `@开发页面` attach;
- [ ] CSP failure diagnostic.

## Evidence

- Browser version (Help → About) and DSH version (host startup log).
- Tested URL and injected config (`dshOrigin`, `mode`, panel flags).
- Pass/fail per row plus a screenshot or short recording path per row.

## Status

### 2026-08-11 — NOT COMPLETED (recorded honestly, not inferred from Chromium)

- Environment: real Google Chrome and Arc are installed on this machine
  (`/Applications/Google Chrome.app`, `/Applications/Arc.app`); Chromium
  automation (Playwright, `channel: 'chromium'`, headless) passes the full
  `e2e/vite-provider.spec.ts` (12 tests) and `e2e/vite-security.spec.ts`
  (8 tests) suites, including HTTPS production fixtures and CSP diagnostics.
- Blocker for the manual gate: a RUNNING real local DSH instance is required
  ("Start local DSH and the dev/HTTPS production fixtures"). The linked DSH
  checkout (`../../.dsh/source/current`) is a full monorepo whose host/web
  build and profile startup were not executed in this session; without a real
  DSH host the checklist rows (embedded DSH Web, `@当前开发页`,
  `@开发页面`) cannot be executed. Starting DSH and completing every row with
  screenshots is deferred to an operator with the DSH profile.
- No row above is claimed as passed. The feature must NOT be marked accepted
  until this section is completed with evidence.

## Instructions for completing the gate

1. Start local DSH with the `@dsh-external/dsh-browser-bridge` plugin
   profile (see `INSTALL.md`).
2. Run the dev and HTTPS fixtures with `dshOrigin` pointing at the real DSH
   port.
3. Execute every row in real Chrome, then in real Arc; record browser/DSH
   versions, URLs, configs, and pass/fail per row with screenshots.
4. If Arc fails, stop and retain the exact failing step; do not mark the
   feature accepted.
5. Replace the Status section above with the dated evidence.
