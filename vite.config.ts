import { readFileSync } from 'node:fs'
import react from '@vitejs/plugin-react'
import { pwaPlugin } from './pwa-plugin.ts'
import { configDefaults, defineConfig } from 'vitest/config'

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string }

// https://vite.dev/config/
export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  plugins: [react(), pwaPlugin()],
  // Relative asset paths: the build works from any sub-path (GitHub Pages, a USB stick behind a local server, …).
  base: './',
  test: {
    // Hardware tests talk to a real device; give them room.
    testTimeout: 30000,
    // Agent/git worktrees live under .claude/; never collect their copies of the tests.
    exclude: [...configDefaults.exclude, '.claude/**', 'e2e/**'],
  },
})
