import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { defineConfig, type Plugin } from 'tsdown'

/**
 * Inline plain `.css` imports as string modules so the DSH client bundle is
 * self-contained (the component injects a `<style>` tag itself). CSS Modules
 * (`.module.css`) are left untouched.
 */
function inlineCssText(): Plugin {
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

export default defineConfig({
  entry: {
    client: 'src/client/index.tsx',
  },
  format: ['cjs'],
  platform: 'browser',
  target: 'es2024',
  dts: false,
  sourcemap: true,
  clean: true,
  outDir: 'lib',
  // React, cordis, and the official client platform modules stay external;
  // everything else (including the shared protocol) is inlined.
  external: [
    'react',
    'react/jsx-runtime',
    'cordis',
    '@deepseek-ai/dsh-client-ui-slots',
    '@deepseek-ai/dsh-client-runtime/client',
  ],
  noExternal: [/^@dsh-external\//],
  plugins: [inlineCssText()],
  outputOptions: {
    entryFileNames: 'client.js',
    // DSH module-loader factory artifact.
    banner: `window.__ModuleLoader__.load({ id: "@dsh-external/dsh-browser-bridge", factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
})
