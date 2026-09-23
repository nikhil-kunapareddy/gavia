import { clearMocks, mockIPC, mockWindows } from '@tauri-apps/api/mocks'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { applyTheme, readTheme, resolveTheme, saveTheme, THEME_KEY } from './theme'

type Listener = () => void

/** A controllable `prefers-color-scheme: dark` query. */
function fakeSystem(dark: boolean) {
  const listeners = new Set<Listener>()
  const query = {
    get matches() {
      return dark
    },
    addEventListener: (_: string, listener: Listener) => listeners.add(listener),
    removeEventListener: (_: string, listener: Listener) => listeners.delete(listener),
  }
  vi.stubGlobal('matchMedia', () => query)
  return {
    set(next: boolean) {
      dark = next
      listeners.forEach((listener) => listener())
    },
    listeners,
  }
}

beforeEach(() => {
  delete document.documentElement.dataset.theme
})

afterEach(() => {
  vi.unstubAllGlobals()
  clearMocks()
  delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
})

describe('readTheme', () => {
  it('defaults to following the system', () => {
    expect(readTheme()).toBe('system')
  })

  it('reads a saved choice and ignores junk', () => {
    saveTheme('dark')
    expect(readTheme()).toBe('dark')
    localStorage.setItem(THEME_KEY, 'purple')
    expect(readTheme()).toBe('system')
  })
})

describe('resolveTheme', () => {
  it('passes fixed choices through and asks the system otherwise', () => {
    fakeSystem(true)
    expect(resolveTheme('light')).toBe('light')
    expect(resolveTheme('system')).toBe('dark')
  })

  it('treats a browser without matchMedia as light', () => {
    vi.stubGlobal('matchMedia', undefined)
    expect(resolveTheme('system')).toBe('light')
  })
})

describe('applyTheme', () => {
  it('follows the system while set to system, and stops when cleaned up', () => {
    const system = fakeSystem(false)
    const stop = applyTheme('system')
    expect(document.documentElement.dataset.theme).toBe('light')

    system.set(true)
    expect(document.documentElement.dataset.theme).toBe('dark')

    stop()
    expect(system.listeners.size).toBe(0)
  })

  it('does not follow the system for a fixed choice', () => {
    const system = fakeSystem(false)
    applyTheme('dark')
    system.set(false)
    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(system.listeners.size).toBe(0)
  })

  it('themes the native window inside the app', async () => {
    fakeSystem(false)
    mockWindows('main')
    const calls: [string, unknown][] = []
    mockIPC((command, payload) => {
      calls.push([command, payload])
      return null
    })

    applyTheme('dark')
    applyTheme('system')

    await vi.waitFor(() => expect(calls).toHaveLength(2))
    expect(calls[0]).toEqual(['plugin:window|set_theme', { label: 'main', value: 'dark' }])
    expect(calls[1]).toEqual(['plugin:window|set_theme', { label: 'main', value: null }])
  })

  it('shrugs off a window that cannot be themed', async () => {
    fakeSystem(false)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // In the app, but without window metadata: getCurrentWindow throws.
    mockIPC(() => null)
    applyTheme('dark')
    expect(warn).toHaveBeenCalled()

    mockWindows('main')
    mockIPC(() => Promise.reject(new Error('no')))
    applyTheme('dark')
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(2))
    expect(document.documentElement.dataset.theme).toBe('dark')
  })
})
