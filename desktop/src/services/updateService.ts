import { relaunch } from '@tauri-apps/plugin-process'
import { check } from '@tauri-apps/plugin-updater'
import { inApp } from './api'

/** A newer release, downloaded and waiting to be installed. */
export interface ReadyUpdate {
  version: string
  /** Install and restart into the new version. On Windows the installer closes Gavia itself. */
  install: () => Promise<void>
}

/**
 * Look for a newer release on GitHub and download it in the background.
 *
 * Resolves to null when there is nothing newer, and on any failure: no
 * network, no stable release published yet, or a Linux install the updater
 * can't replace (the core leaves the updater out there). None of those is
 * worth an error on screen.
 */
export async function downloadUpdate(): Promise<ReadyUpdate | null> {
  if (!inApp()) return null
  try {
    const update = await check()
    if (!update) return null
    await update.download()
    return {
      version: update.version,
      install: async () => {
        await update.install()
        await relaunch()
      },
    }
  } catch (cause) {
    console.warn('Could not check for updates:', cause)
    return null
  }
}
