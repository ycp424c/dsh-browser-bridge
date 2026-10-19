import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { defineConfig, type TsdownPlugin } from 'tsdown'

/** Inline component-owned CSS without introducing a CSS build dependency. */
function inlineCssText(): TsdownPlugin {
  return {
    name: 'dsh-browser-bridge-inline-css-text',
    resolveId(source, importer) {
      if (!source.endsWith('.css') || source.endsWith('.module.css')) return null
      if (importer === undefined) return null
      const abs = resolve(dirname(importer), source)
      // The virtual id must NOT end in .css: tsdown's css-guard matches the
      // suffix and would demand @tsdown/css.
      return `\0dsh-css:${abs.slice(0, -'.css'.length)}`
    },
    load(id) {
      if (!id.startsWith('\0dsh-css:')) return null
      const css = readFileSync(`${id.slice('\0dsh-css:'.length)}.css`, 'utf8')
      return `export default ${JSON.stringify(css)}`
    },
  }
}

export default [
  // Host half: Node ESM library with types. DSH packages and cordis stay
  // external (the profile provides them); the shared protocol is inlined so
  // the plugin package is self-contained.
  defineConfig({
    name: '@ycp424c/dsh-browser-bridge',
    entry: { index: 'src/index.ts' },
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    dts: true,
    tsconfig: process.env.DSH_HOST_TSCONFIG ?? 'tsconfig.host.json',
    clean: true,
    outDir: process.env.DSH_OUT_DIR ?? 'lib',
    outExtension: () => ({ js: '.js', dts: '.d.ts' }),
    // Resolve service identities and request constructors from the running
    // DSH installation instead of embedding an older checkout in the plugin.
    deps: {
      neverBundle: [/^@deepseek-ai\//, 'ws'],
      alwaysBundle: (id) => id === '@ycp424c/dsh-browser-bridge-protocol',
    },
  }),
  // Browser half: DSH module-loader factory artifact at lib/client.js.
  defineConfig({
    name: '@ycp424c/dsh-browser-bridge/client',
    entry: { client: 'src/client/index.tsx' },
    format: ['cjs'],
    platform: 'browser',
    target: 'es2024',
    dts: false,
    tsconfig: process.env.DSH_CLIENT_TSCONFIG ?? 'tsconfig.client.json',
    sourcemap: true,
    clean: false,
    outDir: process.env.DSH_OUT_DIR ?? 'lib',
    deps: {
      neverBundle: [
        'react',
        'react/jsx-runtime',
        '@deepseek-ai/cordis',
        '@deepseek-ai/dsh-client-ui-slots',
      ],
      alwaysBundle: (id) => id === '@ycp424c/dsh-browser-bridge-protocol',
    },
    plugins: [inlineCssText()],
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: "@ycp424c/dsh-browser-bridge", factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  }),
]
