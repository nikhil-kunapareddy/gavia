import { ask } from '@tauri-apps/plugin-dialog'
import { inApp } from './api'

/**
 * Ask the user to confirm something destructive.
 *
 * Inside the app this is a native dialog. `window.confirm` cannot be used
 * there: macOS's WKWebView answers it with `false` without showing anything,
 * which made "Clear history" silently do nothing. In a plain browser (the
 * `npm run dev` preview) there is no native side, so it falls back to
 * `window.confirm`.
 */
export async function confirmAction(message: string, okLabel: string): Promise<boolean> {
  if (!inApp()) return window.confirm(message)
  return ask(message, { title: 'Gavia', kind: 'warning', okLabel, cancelLabel: 'Cancel' })
}
