import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Detection, DetectionResult } from '../types/detection'
import { HistoryPage } from './HistoryPage'

function detection(confidence: number): Detection {
  return {
    id: `d-${confidence}`,
    label: 'Loon',
    confidence,
    boundingBox: { x: 10, y: 10, width: 10, height: 10 },
  }
}

function result(id: string, overrides: Partial<DetectionResult> = {}): DetectionResult {
  return {
    id,
    imageUrl: `gavia://localhost/results/${id}/image`,
    thumbnailUrl: `gavia://localhost/results/${id}/thumb`,
    fileName: `${id}.jpg`,
    fileSize: 2048,
    detections: [],
    processingTime: 0.2,
    timestamp: '2026-09-06T10:00:00.000Z',
    imageWidth: 4000,
    imageHeight: 3000,
    modelName: 'loon_v1',
    tilesProcessed: 1,
    saved: true,
    ...overrides,
  }
}

const onOpenResult = vi.fn()
const onClearHistory = vi.fn()
const onCheckAnother = vi.fn()

beforeEach(() => {
  onOpenResult.mockReset()
  onClearHistory.mockReset()
  onCheckAnother.mockReset()
})

function renderPage(history: DetectionResult[], loading = false) {
  return render(
    <HistoryPage
      history={history}
      loading={loading}
      onOpenResult={onOpenResult}
      onClearHistory={onClearHistory}
      onCheckAnother={onCheckAnother}
    />,
  )
}

describe('while loading', () => {
  it('says so rather than claiming the history is empty', () => {
    // Flashing "no saved checks" before the fetch lands would tell a
    // researcher their records are gone.
    renderPage([], true)

    expect(screen.getByText(/Loading your saved checks/)).toBeInTheDocument()
    expect(screen.queryByText(/No saved checks yet/)).not.toBeInTheDocument()
  })

  it('hides the clear button', () => {
    renderPage([], true)
    expect(screen.queryByRole('button', { name: /Clear history/ })).not.toBeInTheDocument()
  })
})

describe('when empty', () => {
  it('offers a way back to checking an image', async () => {
    const user = userEvent.setup()
    renderPage([])

    expect(screen.getByText(/No saved checks yet/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Check an image' }))

    expect(onCheckAnother).toHaveBeenCalledTimes(1)
  })

  it('does not offer to clear an empty history', () => {
    renderPage([])
    expect(screen.queryByRole('button', { name: /Clear history/ })).not.toBeInTheDocument()
  })
})

describe('listing saved checks', () => {
  it('renders one card per result', () => {
    renderPage([result('a'), result('b'), result('c')])
    expect(screen.getAllByRole('button', { name: /loon|Review/ })).toHaveLength(3)
  })

  it('loads thumbnails rather than full images', () => {
    // The grid used to pull every full-size original at once; thumbnails are
    // roughly 180x smaller.
    const item = result('abc')
    renderPage([item])

    const image = document.querySelector('.history-card img')
    expect(image).toHaveAttribute('src', item.thumbnailUrl)
    expect(item.thumbnailUrl).not.toBe(item.imageUrl)
    expect(image).toHaveAttribute('loading', 'lazy')
  })

  it('summarises how many loons and the best confidence', () => {
    renderPage([result('a', { detections: [detection(0.94), detection(0.81)] })])
    expect(screen.getByText('2 loons · 94% highest confidence')).toBeInTheDocument()
  })

  it('uses the singular for one loon', () => {
    renderPage([result('a', { detections: [detection(0.9)] })])
    expect(screen.getByText(/^1 loon ·/)).toBeInTheDocument()
  })

  it('distinguishes a clear result from a detection', () => {
    renderPage([result('found', { detections: [detection(0.9)] }), result('clear')])

    expect(screen.getByText('Loon detected')).toBeInTheDocument()
    expect(screen.getByText('No loon detected')).toBeInTheDocument()
  })

  it('shows the date of each check', () => {
    renderPage([result('a')])
    expect(screen.getByText(/September 6, 2026/)).toBeInTheDocument()
  })

  it('opens the result that was clicked', async () => {
    const user = userEvent.setup()
    const second = result('b')
    renderPage([result('a'), second])

    await user.click(screen.getAllByRole('button', { name: /Review this result/ })[1])

    expect(onOpenResult).toHaveBeenCalledWith(second)
  })

  it('offers to clear the history once there is something in it', async () => {
    const user = userEvent.setup()
    renderPage([result('a')])

    await user.click(screen.getByRole('button', { name: /Clear history/ }))

    expect(onClearHistory).toHaveBeenCalledTimes(1)
  })
})
