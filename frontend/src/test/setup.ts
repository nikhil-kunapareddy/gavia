import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach, beforeEach, vi } from 'vitest'

/**
 * Guarantees a working `localStorage` global.
 *
 * Node 26 defines its own experimental `localStorage`, which is `undefined`
 * unless the process was started with `--localstorage-file`. That global takes
 * precedence over the one jsdom installs, so tests see `undefined` even under
 * the jsdom environment. Prefer jsdom's implementation and fall back to an
 * in-memory shim.
 */
function ensureLocalStorage(): void {
  const current = (globalThis as { localStorage?: Storage }).localStorage
  if (current && typeof current.clear === 'function') return

  const fromWindow = typeof window !== 'undefined' ? window.localStorage : undefined
  const replacement =
    fromWindow && typeof fromWindow.clear === 'function' ? fromWindow : createMemoryStorage()

  Object.defineProperty(globalThis, 'localStorage', {
    value: replacement,
    configurable: true,
    writable: true,
  })
}

function createMemoryStorage(): Storage {
  const store = new Map<string, string>()

  return {
    get length() {
      return store.size
    },
    clear() {
      store.clear()
    },
    getItem(key: string) {
      return store.get(key) ?? null
    },
    key(index: number) {
      return Array.from(store.keys())[index] ?? null
    },
    removeItem(key: string) {
      store.delete(key)
    },
    setItem(key: string, value: string) {
      store.set(key, String(value))
    },
  } satisfies Storage
}

ensureLocalStorage()

// jsdom implements neither; the uploader and preview flow depend on both.
if (typeof URL.createObjectURL !== 'function') {
  URL.createObjectURL = vi.fn(() => 'blob:mock-url')
  URL.revokeObjectURL = vi.fn()
}

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  localStorage.clear()
})
