import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  dts: true,
  clean: true,
  outDir: 'lib',
  outExtension: () => ({ js: '.js', dts: '.d.ts' }),
})
