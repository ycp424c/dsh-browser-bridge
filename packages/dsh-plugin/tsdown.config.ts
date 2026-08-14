import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { defineConfig, type TsdownPlugin } from 'tsdown'

/**
 * Inline plain `.css` imports as string modules so the DSH client bundle is
 * self-contained (the component injects a `<style>` tag itself). CSS Modules
 * (`.module.css`) are left untouched.
 */
/**
 * Resolve `@deepseek-ai/*` imports to the linked DSH checkout source so the
 * runtime packages can be inlined into the host bundle.
 */
function dshSourceResolver(): TsdownPlugin {
  const pathsFile = resolve(import.meta.dirname, '../../.dsh/tsconfig.paths.json')
  let paths: Record<string, string[]> = {}
  try {
    paths = (JSON.parse(readFileSync(pathsFile, 'utf8')) as {
      compilerOptions: { paths: Record<string, string[]> }
    }).compilerOptions.paths
  } catch {
    // No linked checkout: keep the imports external.
  }
  return {
    name: 'dsh-browser-bridge-dsh-source',
    resolveId(source) {
      // Exact keys cover the checkout's packages and its vendored scoped
      // cordis, cosmokit, schemastery, and plugin packages.
      const target = paths[source]?.[0]
      if (target === undefined) return null
      if (source === '@deepseek-ai/cordis') console.log('[resolver] @deepseek-ai/cordis ->', target)
      return resolve(import.meta.dirname, '../../.dsh', target)
    },
  }
}

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
    clean: true,
    outDir: 'lib',
    outExtension: () => ({ js: '.js', dts: '.d.ts' }),
    plugins: [dshSourceResolver()],
    // Schemastery and ws are plugin runtime dependencies. The DSH runtime
    // packages are inlined so the plugin works against a source checkout AND
    // a built installation; cordis is type-only in the host entry.
    deps: {
      neverBundle: ['@deepseek-ai/schemastery', 'ws'],
      // protocol and the DSH runtime packages are inlined (they are
      // not declared production dependencies), so the automatic
      // externalization never shadows the alwaysBundle list.
      alwaysBundle: (id) =>
        id === '@ycp424c/dsh-browser-bridge-protocol'
        || (id.startsWith('@deepseek-ai/') && id !== '@deepseek-ai/schemastery'),
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
    sourcemap: true,
    clean: false,
    outDir: 'lib',
    deps: {
      neverBundle: [
        'react',
        'react/jsx-runtime',
        '@deepseek-ai/cordis',
        '@deepseek-ai/dsh-client-ui-slots',
        '@deepseek-ai/dsh-client-runtime/client',
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
