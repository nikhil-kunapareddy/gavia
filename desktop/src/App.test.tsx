import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { ApiError } from './services/api'
import { analyzeImage } from './services/detectionService'
import { clearHistory, loadHistory, saveResult } from './services/historyService'

vi.mock('./services/detectionService', () => ({ analyzeImage: vi.fn() }))
vi.mock('./services/historyService', () => ({
  loadHistory: vi.fn(),
  saveResult: vi.fn(),
  clearHistory: vi.fn(),
}))
// Settings has its own suite in App.settings.test.tsx; here it only needs to load.
vi.mock('./services/settingsService', () => ({
  getSettings: vi.fn(() => new Promise(() => {})),
}))

const analyzeImageMock = vi.mocked(analyzeImage)
const loadHistoryMock = vi.mocked(loadHistory)
const saveResultMock = vi.mocked(saveResult)
const clearHistoryMock = vi.mocked(clearHistory)

function makeResult(overrides = {}) {
  return {
    id: 'result-1',
    imageUrl: '',
    thumbnailUrl: '',
    fileName: 'loon.jpg',
    fileSize: 11,
    detections: [
      {
        id: 'loon-1',
        label: 'Loon',
        confidence: 0.94,
        boundingBox: { x: 10, y: 10, width: 20, height: 20 },
      },
    ],
    processingTime: 1.1,
    timestamp: '2026-09-06T10:00:00.000Z',
    imageWidth: 4000,
    imageHeight: 3000,
    modelName: 'loon_v1',
    tilesProcessed: 1,
    saved: false,
    ...overrides,
  }
}

function selectFile() {
  return new File(['image-bytes'], 'loon.jpg', { type: 'image/jpeg' })
}

beforeEach(() => {
  analyzeImageMock.mockReset()
  loadHistoryMock.mockReset()
  saveResultMock.mockReset()
  clearHistoryMock.mockReset()
  loadHistoryMock.mockResolvedValue([])
})

/**
 * Render and let the mount-time history fetch settle.
 *
 * App loads history in an effect; asserting before it resolves lets the state
 * update land outside act(), which React warns about and which can interleave
 * unpredictably with later assertions.
 */
async function renderApp() {
  render(<App />)
  await waitFor(() => expect(loadHistoryMock).toHaveBeenCalled())
}

describe('App navigation', () => {
  it('starts on the check page', async () => {
    await renderApp()
    expect(screen.getByRole('heading', { name: /Is this a loon\?/ })).toBeInTheDocument()
  })

  it('navigates to previous checks and back', async () => {
    const user = userEvent.setup()
    await renderApp()

    await user.click(screen.getByRole('button', { name: /Previous checks/ }))
    expect(await screen.findByRole('heading', { name: 'Previous checks' })).toBeInTheDocument()

    // The nav and the empty state both offer "Check an image"; this is the
    // one inside the empty state.
    const nav = screen.getByRole('navigation')
    const [emptyStateButton] = screen
      .getAllByRole('button', { name: 'Check an image' })
      .filter((button) => !nav.contains(button))
    await user.click(emptyStateButton)
    expect(screen.getByRole('heading', { name: /Is this a loon\?/ })).toBeInTheDocument()
  })

  it('keeps the about section on the settings page', async () => {
    const user = userEvent.setup()
    await renderApp()
    await user.click(screen.getByRole('button', { name: /Settings/ }))
    expect(screen.getByRole('heading', { name: 'Settings' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /Built to support/ })).toBeInTheDocument()
  })
})

describe('checking an image', () => {
  it('surfaces an error and re-enables the button when analysis fails', async () => {
    const user = userEvent.setup()
    analyzeImageMock.mockRejectedValue(new Error('backend exploded'))
    vi.spyOn(console, 'error').mockImplementation(() => {})

    await renderApp()
    const input = document.querySelector('input[type="file"]')
    expect(input).not.toBeNull()
    await user.upload(input as HTMLInputElement, selectFile())

    const checkButton = await screen.findByRole('button', { name: /Check for loons/ })
    await user.click(checkButton)

    // The original code left `processing` true forever, permanently disabling
    // the button and stranding the user.
    expect(await screen.findByRole('alert')).toHaveTextContent(/Something went wrong/)
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Check for loons/ })).toBeEnabled()
    })
  })

  it('shows the core message for an error the user can act on', async () => {
    const user = userEvent.setup()
    analyzeImageMock.mockRejectedValue(
      new ApiError('UNSUPPORTED_FORMAT', 'image/gif is not supported.', 415),
    )
    vi.spyOn(console, 'error').mockImplementation(() => {})

    await renderApp()
    const input = document.querySelector('input[type="file"]')
    await user.upload(input as HTMLInputElement, selectFile())
    await user.click(await screen.findByRole('button', { name: /Check for loons/ }))

    expect(await screen.findByRole('alert')).toHaveTextContent('image/gif is not supported.')
  })

  it('does not treat a NETWORK_ERROR as actionable, since there is no network any more', async () => {
    const user = userEvent.setup()
    analyzeImageMock.mockRejectedValue(new ApiError('NETWORK_ERROR', 'Could not reach it.', 0))
    vi.spyOn(console, 'error').mockImplementation(() => {})

    await renderApp()
    const input = document.querySelector('input[type="file"]')
    await user.upload(input as HTMLInputElement, selectFile())
    await user.click(await screen.findByRole('button', { name: /Check for loons/ }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/Something went wrong/)
    expect(alert).not.toHaveTextContent('Could not reach it.')
  })

  it('shows the result when analysis succeeds', async () => {
    const user = userEvent.setup()
    analyzeImageMock.mockResolvedValue(makeResult())

    await renderApp()
    const input = document.querySelector('input[type="file"]')
    await user.upload(input as HTMLInputElement, selectFile())
    await user.click(await screen.findByRole('button', { name: /Check for loons/ }))

    expect(await screen.findByRole('heading', { name: '1 loon detected' })).toBeInTheDocument()
  })
})

describe('saving a result', () => {
  async function checkAnImage(user: ReturnType<typeof userEvent.setup>) {
    await renderApp()
    const input = document.querySelector('input[type="file"]')
    await user.upload(input as HTMLInputElement, selectFile())
    await user.click(await screen.findByRole('button', { name: /Check for loons/ }))
    await screen.findByRole('heading', { name: '1 loon detected' })
  }

  it('sends the image with the result and reflects the saved state', async () => {
    const user = userEvent.setup()
    analyzeImageMock.mockResolvedValue(makeResult())
    saveResultMock.mockResolvedValue(
      makeResult({
        saved: true,
        imageUrl: 'gavia://localhost/results/result-1/image',
        thumbnailUrl: 'gavia://localhost/results/result-1/thumb',
      }),
    )

    await checkAnImage(user)
    await user.click(screen.getByRole('button', { name: /Save result/ }))

    // The file has to travel with the save: nothing was persisted at
    // detection time, so the backend has no copy of the image yet.
    await waitFor(() => expect(saveResultMock).toHaveBeenCalledTimes(1))
    expect(saveResultMock.mock.calls[0][1]).toBeInstanceOf(File)
    expect(await screen.findByRole('button', { name: /Saved to history/ })).toBeDisabled()
  })

  it('keeps the result on screen when saving fails', async () => {
    const user = userEvent.setup()
    analyzeImageMock.mockResolvedValue(makeResult())
    saveResultMock.mockRejectedValue(new Error('disk full'))
    vi.spyOn(console, 'error').mockImplementation(() => {})

    await checkAnImage(user)
    await user.click(screen.getByRole('button', { name: /Save result/ }))

    // A failed save must not discard the detections the user is looking at.
    await waitFor(() => expect(screen.getByRole('button', { name: /Save result/ })).toBeEnabled())
    expect(screen.getByRole('heading', { name: '1 loon detected' })).toBeInTheDocument()
  })
})

describe('history', () => {
  it('lists saved checks from the backend', async () => {
    loadHistoryMock.mockResolvedValue([
      makeResult({ id: 'saved-1', fileName: 'nest.jpg', saved: true }),
    ])
    const user = userEvent.setup()
    await renderApp()

    await user.click(screen.getByRole('button', { name: /Previous checks/ }))
    expect(await screen.findByText(/1 loon/)).toBeInTheDocument()
  })

  it('stays usable when the backend cannot be reached', async () => {
    // The check page should still work with history unavailable.
    loadHistoryMock.mockRejectedValue(new Error('offline'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const user = userEvent.setup()
    await renderApp()

    await user.click(screen.getByRole('button', { name: /Previous checks/ }))
    expect(await screen.findByText(/No saved checks yet/)).toBeInTheDocument()
  })
})
