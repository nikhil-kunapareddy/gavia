/**
 * Whether Gavia looks for a new release when it starts. On unless turned off.
 *
 * Kept in `localStorage` beside the theme rather than in the core's settings:
 * the check is started from the UI, so the core never needs to know.
 */

export const AUTO_UPDATE_KEY = 'gavia.autoUpdate'

export function readAutoUpdate(): boolean {
  return localStorage.getItem(AUTO_UPDATE_KEY) !== 'off'
}

export function saveAutoUpdate(on: boolean): void {
  localStorage.setItem(AUTO_UPDATE_KEY, on ? 'on' : 'off')
}
