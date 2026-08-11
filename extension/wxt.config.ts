import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'wxt'

export default defineConfig({
  outDir: 'output',
  modules: ['@wxt-dev/module-react'],
  vite: () => ({ plugins: [tailwindcss()] }),
  manifest: {
    minimum_chrome_version: '118',
    name: 'DSH Browser Bridge',
    description: 'Attach explicit Chrome tabs to individual DSH prompts.',
    permissions: ['debugger', 'tabs', 'storage'],
    action: { default_title: 'Open DSH Browser Bridge' },
    content_security_policy: {
      extension_pages: "script-src 'self'; object-src 'self'; frame-src http://127.0.0.1:* http://localhost:*; connect-src 'self' ws://127.0.0.1:* ws://localhost:* http://127.0.0.1:* http://localhost:*",
    },
  },
})
