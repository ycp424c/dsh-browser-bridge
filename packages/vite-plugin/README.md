# @dsh-external/dsh-browser-bridge-vite

Vite plugin that injects the DSH browser bridge page runtime. Dev serves
inject by default; production builds inject only with the explicit
`bridge.injectInBuild: true` switch, and the serialized config keeps the
production default of zero-network dormancy. Library mode and non-HTML SSR
output are never injected.

```ts
import { dshBrowserBridge } from '@dsh-external/dsh-browser-bridge-vite'

export default defineConfig({
  plugins: [dshBrowserBridge({ dshOrigin: 'http://127.0.0.1:3080' })],
})
```

- `dshOrigin` accepts only loopback HTTP(S) origins; credentials, remote
  hosts, and non-HTTP(S) schemes are rejected at config time.
- The options schema is strict: secret-shaped keys are rejected because every
  option ends up in the frontend bundle.
- Serialized configs escape `<`, U+2028, and U+2029 so inline module scripts
  can never be broken out of.
- The virtual runtime module wires the official Vite HMR events
  (`vite:afterUpdate` / `dispose`) in development.

See the workspace [README](../../README.md) and
[INSTALL.md](../../INSTALL.md) for installation and configuration.
