import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { analyzeImage } from './services/detectionService'

vi.mock('./services/detectionService', () => ({ analyzeImage: vi.fn() }))

const analyzeImageMock = vi.mocked(analyzeImage)

function selectFile() {
  return new File(['image-bytes'], 'loon.jpg', { type: 'image/jpeg' })
}

beforeEach(() => {
  localStorage.clear()
  analyzeImageMock.mockReset()
})

describe('App navigation', () => {
  it('starts on the check page', () => {
    render(<App />)
    expect(screen.getByRole('heading', { name: /Is this a loon\?/ })).toBeInTheDocument()
  })

  it('navigates to previous checks and back', async () => {
    const user = userEvent.setup()
    render(<App />)

    await user.click(screen.getByRole('button', { name: /Previous checks/ }))
    expect(screen.getByRole('heading', { name: 'Previous checks' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Check an image' }))
    expect(screen.getByRole('heading', { name: /Is this a loon\?/ })).toBeInTheDocument()
  })

  it('navigates to the about page', async () => {
    const user = userEvent.setup()
    render(<App />)
    await user.click(screen.getByRole('button', { name: /About/ }))
    expect(screen.getByRole('heading', { name: /Built to support/ })).toBeInTheDocument()
  })
})

describe('checking an image', () => {
  it('surfaces an error and re-enables the button when analysis fails', async () => {
    const user = userEvent.setup()
    analyzeImageMock.mockRejectedValue(new Error('backend exploded'))
    vi.spyOn(console, 'error').mockImplementation(() => {})

    render(<App />)
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

  it('shows the result when analysis succeeds', async () => {
    const user = userEvent.setup()
    analyzeImageMock.mockResolvedValue({
      id: 'result-1',
      imageUrl: 'data:image/png;base64,abc',
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
    })

    render(<App />)
    const input = document.querySelector('input[type="file"]')
    await user.upload(input as HTMLInputElement, selectFile())
    await user.click(await screen.findByRole('button', { name: /Check for loons/ }))

    expect(await screen.findByRole('heading', { name: '1 loon detected' })).toBeInTheDocument()
  })
})
