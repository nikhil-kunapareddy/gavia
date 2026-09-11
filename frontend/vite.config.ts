import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

// The e2e suite runs the backend on its own port so it cannot collide with a
// dev server you already have open.
const apiTarget = process.env.VITE_API_PROXY_TARGET ?? 'http://127.0.0.1:8000'

export default defineConfig({
  plugins: [react()],
  server: {
    // Same-origin in development, matching how the packaged desktop app
    // serves the frontend and the sidecar together. Avoids CORS entirely and
    // lets every request in the app use a plain relative URL.
    proxy: {
      '/api': {
        target: apiTarget,
        changeOrigin: false,
      },
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    css: false,
    // The e2e specs are Playwright's, and importing them here would try to
    // run a browser inside jsdom.
    exclude: ['node_modules/**', 'dist/**', 'e2e/**'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      // src/types is interface declarations only — no runtime code to cover.
      exclude: ['src/test/**', 'src/**/*.test.{ts,tsx}', 'src/main.tsx', 'src/types/**'],
    },
  },
})
