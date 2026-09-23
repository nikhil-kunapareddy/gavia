import { clearMocks, mockIPC } from '@tauri-apps/api/mocks'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  chooseDataDir,
  getSettings,
  openFolder,
  resetDataDir,
  selectModel,
} from './settingsService'

let calls: [string, unknown][]
let picked: string | null

beforeEach(() => {
  calls = []
  picked = '/Volumes/Field'
  mockIPC((command, payload) => {
    calls.push([command, payload])
    if (command === 'plugin:dialog|open') return picked
    return { dataDir: '/x' }
  })
})

afterEach(() => {
  clearMocks()
  delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
})

describe('settingsService', () => {
  it('reads settings', async () => {
    await expect(getSettings()).resolves.toEqual({ dataDir: '/x' })
    expect(calls[0][0]).toBe('get_settings')
  })

  it('asks for a folder, starting from the current one, then moves there', async () => {
    await chooseDataDir('/Users/me/Gavia')

    expect(calls[0][0]).toBe('plugin:dialog|open')
    expect(calls[0][1]).toMatchObject({
      options: { directory: true, defaultPath: '/Users/me/Gavia' },
    })
    expect(calls[1]).toEqual(['set_data_dir', { path: '/Volumes/Field' }])
  })

  it('moves nothing when the picker is cancelled', async () => {
    picked = null
    await expect(chooseDataDir('/Users/me/Gavia')).resolves.toBeNull()
    expect(calls.map(([command]) => command)).toEqual(['plugin:dialog|open'])
  })

  it('resets to the default with a null path', async () => {
    await resetDataDir()
    expect(calls[0]).toEqual(['set_data_dir', { path: null }])
  })

  it('selects a model and opens folders by name', async () => {
    await selectModel('loon_v2')
    await openFolder('models')
    expect(calls).toEqual([
      ['select_model', { id: 'loon_v2' }],
      ['open_folder', { which: 'models' }],
    ])
  })
})
