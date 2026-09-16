import { defineConfig, devices } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * End-to-end tests: a real browser, the real Vite app, the real FastAPI
 * backend, and the real ONNX model. Nothing is stubbed.
 *
 * Playwright starts both servers itself, so `npm run test:e2e` is the whole
 * command. The backend gets a throwaway data directory per run — these tests
 * save and clear history, and must never touch a real one.
 */

// Ports the app does not use in normal development, so an e2e run cannot
// collide with a dev server you already have open. Override if they clash.
const BACKEND_PORT = Number(process.env.E2E_BACKEND_PORT ?? 8111)
const FRONTEND_PORT = Number(process.env.E2E_FRONTEND_PORT ?? 5179)
const DATA_DIR = mkdtempSync(join(tmpdir(), 'gavia-e2e-'))
const REPO_ROOT = new URL('..', import.meta.url).pathname

export default defineConfig({
  testDir: './e2e',
  // The model is loaded once per worker; a second worker would double the
  // memory for no gain on a suite this size.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'list' : [['list']],

  use: {
    baseURL: `http://127.0.0.1:${FRONTEND_PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },

  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],

  webServer: [
    {
      command: `${REPO_ROOT}gavia-venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port ${BACKEND_PORT}`,
      cwd: `${REPO_ROOT}backend`,
      env: { DATA_DIR, DEBUG: 'false' },
      url: `http://127.0.0.1:${BACKEND_PORT}/api/health`,
      reuseExistingServer: false,
      // Cold start includes loading and warming the 36MB model.
      timeout: 60_000,
      stdout: 'pipe',
    },
    {
      // --host 127.0.0.1 because Vite otherwise binds IPv6 localhost only,
      // and the readiness check below polls the IPv4 address.
      command: `npx vite --host 127.0.0.1 --port ${FRONTEND_PORT} --strictPort`,
      url: `http://127.0.0.1:${FRONTEND_PORT}`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: { VITE_API_PROXY_TARGET: `http://127.0.0.1:${BACKEND_PORT}` },
    },
  ],
})
