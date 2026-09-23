import { open } from '@tauri-apps/plugin-dialog'
import type { AppSettings } from '../types/settings'
import { call } from './api'

export async function getSettings(): Promise<AppSettings> {
  return call<AppSettings>('get_settings')
}

/**
 * Let the user pick a new storage folder, then move history there.
 *
 * Resolves to `null` if they cancel the folder picker. The core decides what
 * happens to the folder: an existing Gavia history is reopened, an empty
 * folder is used directly, and anything else gets a `Gavia` folder inside.
 */
export async function chooseDataDir(current: string): Promise<AppSettings | null> {
  const picked = await open({
    directory: true,
    defaultPath: current,
    title: 'Choose where Gavia keeps your saved checks',
  })
  if (typeof picked !== 'string') return null
  return call<AppSettings>('set_data_dir', { path: picked })
}

/** Move history back to the platform's default folder. */
export async function resetDataDir(): Promise<AppSettings> {
  return call<AppSettings>('set_data_dir', { path: null })
}

/** Switch models. The new one loads in the background: `modelStatus` is `starting` until it's ready. */
export async function selectModel(id: string): Promise<AppSettings> {
  return call<AppSettings>('select_model', { id })
}

export async function openFolder(which: 'data' | 'models'): Promise<void> {
  await call<void>('open_folder', { which })
}
