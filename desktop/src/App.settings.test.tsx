/**
 * The Settings page wired into App: theme, storage location and model, with
 * the settings service mocked. The service's own calls are covered in
 * services/settingsService.test.ts, and the Rust side in tests/settings.rs.
 */

import { act, render, screen, waitFor, waitForElementToBeRemoved } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { THEME_KEY } from './lib/theme'
import { ApiError } from './services/api'
import { loadHistory } from './services/historyService'
import {
  chooseDataDir,
  getSettings,
  openFolder,
  resetDataDir,
  selectModel,
} from './services/settingsService'
import type { AppSettings } from './types/settings'

vi.mock('./services/detectionService', () => ({ analyzeImage: vi.fn() }))
vi.mock('./services/historyService', () => ({
  loadHistory: vi.fn(),
  saveResult: vi.fn(),
  clearHistory: vi.fn(),
}))
vi.mock('./services/settingsService', () => ({
  getSettings: vi.fn(),
  chooseDataDir: vi.fn(),
  resetDataDir: vi.fn(),
  selectModel: vi.fn(),
  openFolder: vi.fn(),
}))

function makeSettings(overrides: Partial<AppSettings> = {}): AppSettings {
  return {
    dataDir: '/Users/me/Library/Gavia',
    defaultDataDir: '/Users/me/Library/Gavia',
    isDefaultDataDir: true,
    dataDirLocked: false,
    modelsDir: '/Users/me/Library/Gavia/models',
    model: 'loon_v1',
    models: [
      {
        id: 'loon_v1',
        name: 'Loonet 1.0',
        architecture: 'YOLO11s',
        classes: ['common loon'],
        metrics: { precision: 0.906, recall: 0.879, mAP50: 0.892 },
        custom: false,
      },
      {
        id: 'loon_v2',
        name: 'loon_v2',
        architecture: 'YOLO11m',
        classes: ['common loon'],
        metrics: {},
        custom: true,
      },
    ],
    modelStatus: 'ok',
    savedChecks: 3,
    version: '0.1.0',
    ...overrides,
  }
}

beforeEach(() => {
  vi.mocked(loadHistory).mockResolvedValue([])
  vi.mocked(getSettings).mockResolvedValue(makeSettings())
  vi.mocked(openFolder).mockResolvedValue()
  delete document.documentElement.dataset.theme
})

afterEach(() => {
  vi.useRealTimers()
})

async function openSettings() {
  const user = userEvent.setup()
  render(<App />)
  await waitFor(() => expect(loadHistory).toHaveBeenCalled())
  await user.click(screen.getByRole('button', { name: /Settings/ }))
  await screen.findByText('/Users/me/Library/Gavia')
  return user
}

describe('appearance', () => {
  it('follows the system until a theme is chosen', async () => {
    await openSettings()
    expect(screen.getByRole('radio', { name: /System/ })).toHaveAttribute('aria-checked', 'true')
  })

  it('switches theme at once and remembers it', async () => {
    const user = await openSettings()

    await user.click(screen.getByRole('radio', { name: /Dark/ }))

    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(localStorage.getItem(THEME_KEY)).toBe('dark')
    expect(screen.getByRole('radio', { name: /Dark/ })).toHaveAttribute('aria-checked', 'true')

    await user.click(screen.getByRole('radio', { name: /Light/ }))
    expect(document.documentElement.dataset.theme).toBe('light')
  })

  it('starts with the remembered theme', async () => {
    localStorage.setItem(THEME_KEY, 'dark')
    await openSettings()
    expect(screen.getByRole('radio', { name: /Dark/ })).toHaveAttribute('aria-checked', 'true')
    expect(document.documentElement.dataset.theme).toBe('dark')
  })
})

describe('storage location', () => {
  it('shows where history lives and how much is there', async () => {
    await openSettings()
    expect(screen.getByText(/3 saved checks · default location/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Use default/ })).not.toBeInTheDocument()
  })

  it('opens the folder in the file manager', async () => {
    const user = await openSettings()
    await user.click(screen.getByRole('button', { name: 'Open folder' }))
    expect(openFolder).toHaveBeenCalledWith('data')
  })

  it('reports a folder that will not open', async () => {
    const user = await openSettings()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(openFolder).mockRejectedValue(new Error('no file manager'))
    await user.click(screen.getByRole('button', { name: 'Open folder' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not be opened/)
  })

  it('moves history and reloads it from the new place', async () => {
    const user = await openSettings()
    vi.mocked(chooseDataDir).mockResolvedValue(
      makeSettings({ dataDir: '/Volumes/Field/Gavia', isDefaultDataDir: false }),
    )
    vi.mocked(loadHistory).mockClear()

    await user.click(screen.getByRole('button', { name: /Change/ }))

    expect(await screen.findByText('/Volumes/Field/Gavia')).toBeInTheDocument()
    expect(chooseDataDir).toHaveBeenCalledWith('/Users/me/Library/Gavia')
    expect(loadHistory).toHaveBeenCalled()
    expect(screen.getByRole('button', { name: /Use default/ })).toBeInTheDocument()
  })

  it('does nothing when the folder picker is cancelled', async () => {
    const user = await openSettings()
    vi.mocked(chooseDataDir).mockResolvedValue(null)
    vi.mocked(loadHistory).mockClear()

    await user.click(screen.getByRole('button', { name: /Change/ }))

    await waitFor(() => expect(screen.getByRole('button', { name: /Change/ })).toBeEnabled())
    expect(loadHistory).not.toHaveBeenCalled()
  })

  it('moves back to the default location', async () => {
    vi.mocked(getSettings).mockResolvedValue(
      makeSettings({ dataDir: '/Volumes/Field/Gavia', isDefaultDataDir: false }),
    )
    vi.mocked(resetDataDir).mockResolvedValue(makeSettings())
    const user = userEvent.setup()
    render(<App />)
    await user.click(screen.getByRole('button', { name: /Settings/ }))

    await user.click(await screen.findByRole('button', { name: /Use default/ }))

    expect(await screen.findByText(/default location/)).toBeInTheDocument()
  })

  it("explains why a folder can't be used", async () => {
    const user = await openSettings()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(chooseDataDir).mockRejectedValue(
      new ApiError('INVALID_REQUEST', 'That folder already has a Gavia folder.', 422),
    )

    await user.click(screen.getByRole('button', { name: /Change/ }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'That folder already has a Gavia folder.',
    )
  })

  it('hides internal errors behind a plain message', async () => {
    const user = await openSettings()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(chooseDataDir).mockRejectedValue(new ApiError('INTERNAL_ERROR', 'EACCES', 500))

    await user.click(screen.getByRole('button', { name: /Change/ }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/could not be changed/)
    expect(alert).not.toHaveTextContent('EACCES')
  })

  it('cannot be changed when set by the environment', async () => {
    vi.mocked(getSettings).mockResolvedValue(makeSettings({ dataDirLocked: true }))
    await openSettings()
    expect(screen.getByText(/Set by GAVIA_DATA_DIR/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Change/ })).not.toBeInTheDocument()
  })
})

describe('detection model', () => {
  it('names the only model without offering a choice', async () => {
    vi.mocked(getSettings).mockResolvedValue(
      makeSettings({ models: makeSettings().models.slice(0, 1) }),
    )
    await openSettings()
    expect(screen.getByText('Loonet 1.0')).toBeInTheDocument()
    expect(screen.queryByRole('combobox', { name: 'Model' })).not.toBeInTheDocument()
    expect(screen.queryByText('YOLO11s')).not.toBeInTheDocument()
    expect(screen.queryByText('Ready')).not.toBeInTheDocument()
  })

  it('offers a choice once a second model is added', async () => {
    await openSettings()
    const select = screen.getByRole('combobox', { name: 'Model' })
    expect(select).toHaveValue('loon_v1')
    expect(screen.getByRole('option', { name: 'loon_v2 (added)' })).toBeInTheDocument()
  })

  it('switches model and waits for it to load', async () => {
    const user = await openSettings()
    vi.mocked(selectModel).mockResolvedValue(
      makeSettings({ model: 'loon_v2', modelStatus: 'starting' }),
    )
    vi.mocked(getSettings).mockResolvedValue(makeSettings({ model: 'loon_v2' }))

    await user.selectOptions(screen.getByRole('combobox', { name: 'Model' }), 'loon_v2')

    expect(selectModel).toHaveBeenCalledWith('loon_v2')
    expect(await screen.findByText('Loading…')).toBeInTheDocument()
    await waitForElementToBeRemoved(() => screen.queryByText('Loading…'), { timeout: 3000 })
    expect(screen.getByRole('combobox', { name: 'Model' })).toHaveValue('loon_v2')
  })

  it('says so when a model fails to load', async () => {
    vi.mocked(getSettings).mockResolvedValue(makeSettings({ modelStatus: 'degraded' }))
    await openSettings()
    expect(screen.getByText('Could not load this model')).toBeInTheDocument()
  })

  it('has no models folder button', async () => {
    await openSettings()
    expect(screen.queryByRole('button', { name: /Open models folder/ })).not.toBeInTheDocument()
  })
})

it('shows the app version', async () => {
  await openSettings()
  expect(screen.getByRole('heading', { name: 'App version' })).toBeInTheDocument()
  expect(screen.getByText('0.1.0')).toBeInTheDocument()
  expect(screen.queryByText('Gavia 0.1.0')).not.toBeInTheDocument()
})

it('reports settings that fail to load', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.mocked(getSettings).mockRejectedValue(new Error('core down'))
  const user = userEvent.setup()
  render(<App />)
  await act(async () => {
    await user.click(screen.getByRole('button', { name: /Settings/ }))
  })
  expect(await screen.findByRole('alert')).toHaveTextContent(/could not be loaded/)
  expect(screen.getAllByText('Loading…')).toHaveLength(2)
})
