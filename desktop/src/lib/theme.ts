import { getCurrentWindow } from '@tauri-apps/api/window'
import { inApp } from '../services/api'
import type { ThemeChoice } from '../types/settings'

/**
 * Light, dark, or whatever the system is set to.
 *
 * Kept in `localStorage` rather than the core's settings file so it can be
 * applied synchronously in `main.tsx`, before the first paint — a round trip
 * to Rust first would flash the light theme on a dark desktop. The palette
 * itself is CSS variables on `:root[data-theme]` in `index.css`.
 */

export const THEME_KEY = 'gavia.theme'
const CHOICES: ThemeChoice[] = ['light', 'dark', 'system']
const DARK_QUERY = '(prefers-color-scheme: dark)'

export function readTheme(): ThemeChoice {
  const stored = localStorage.getItem(THEME_KEY)
  return CHOICES.includes(stored as ThemeChoice) ? (stored as ThemeChoice) : 'system'
}

function systemIsDark(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia(DARK_QUERY).matches
}

/** What `system` means right now. */
export function resolveTheme(choice: ThemeChoice): 'light' | 'dark' {
  if (choice !== 'system') return choice
  return systemIsDark() ? 'dark' : 'light'
}

/**
 * Apply a choice to the page, and to the native window so its title bar and
 * the native dialogs match. Returns a function that stops following the
 * system, for when `system` is replaced by a fixed choice.
 */
export function applyTheme(choice: ThemeChoice): () => void {
  document.documentElement.dataset.theme = resolveTheme(choice)
  if (inApp()) themeWindow(choice)

  if (choice !== 'system' || typeof window.matchMedia !== 'function') return () => {}
  const query = window.matchMedia(DARK_QUERY)
  const follow = () => {
    document.documentElement.dataset.theme = resolveTheme('system')
  }
  query.addEventListener('change', follow)
  return () => query.removeEventListener('change', follow)
}

/**
 * The native window's title bar and dialogs. Cosmetic, so a failure — or no
 * window at all, as under a test's IPC mock — is logged and ignored.
 */
function themeWindow(choice: ThemeChoice): void {
  try {
    // null tells Tauri to follow the system.
    getCurrentWindow()
      .setTheme(choice === 'system' ? null : choice)
      .catch((cause: unknown) => console.warn('Could not theme the window:', cause))
  } catch (cause) {
    console.warn('Could not theme the window:', cause)
  }
}

export function saveTheme(choice: ThemeChoice): void {
  localStorage.setItem(THEME_KEY, choice)
}
