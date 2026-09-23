import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [react()],
  // Tauri waits on this exact port (`build.devUrl`), so fail rather than
  // drift to another one.
  server: { port: 5173, strictPort: true, watch: { ignored: ['**/src-tauri/**'] } },
  clearScreen: false,
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    css: false,
    exclude: ['node_modules/**', 'dist/**', 'src-tauri/**'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      // src/types is interface declarations only; src/dev only runs in a
      // plain browser, never inside the app.
      exclude: [
        'src/test/**',
        'src/**/*.test.{ts,tsx}',
        'src/main.tsx',
        'src/types/**',
        'src/dev/**',
      ],
    },
  },
})
