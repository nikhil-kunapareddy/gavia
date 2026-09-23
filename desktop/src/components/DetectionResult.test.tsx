import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Detection, DetectionResult as Result } from '../types/detection'
import { DetectionResult } from './DetectionResult'

function detection(id: string, confidence: number): Detection {
  return { id, label: 'Loon', confidence, boundingBox: { x: 10, y: 10, width: 20, height: 20 } }
}

function makeResult(detections: Detection[]): Result {
  return {
    id: 'result-1',
    imageUrl: 'data:image/png;base64,abc',
    thumbnailUrl: '',
    fileName: 'photo.jpg',
    fileSize: 1000,
    detections,
    processingTime: 1.1,
    timestamp: '2026-09-06T10:00:00.000Z',
    imageWidth: 4000,
    imageHeight: 3000,
    modelName: 'loon_v1',
    tilesProcessed: 1,
    saved: false,
  }
}

function renderResult(detections: Detection[]) {
  return render(
    <DetectionResult
      result={makeResult(detections)}
      onCheckAnother={vi.fn()}
      onSave={vi.fn()}
      saved={false}
    />,
  )
}

describe('DetectionResult', () => {
  it('shows the true maximum confidence when detections are unsorted', () => {
    const { container } = renderResult([
      detection('a', 0.62),
      detection('b', 0.97),
      detection('c', 0.81),
    ])

    // Scoped to the summary card: 97% also appears in its own detection row.
    const card = container.querySelector('.confidence-card')
    expect(card).not.toBeNull()
    // Reading detections[0] would have shown 62% here.
    expect(within(card as HTMLElement).getByText('97%')).toBeInTheDocument()
  })

  it('reports a singular loon for one detection', () => {
    renderResult([detection('a', 0.94)])
    expect(screen.getByRole('heading', { name: '1 loon detected' })).toBeInTheDocument()
  })

  it('reports plural loons for several detections', () => {
    renderResult([detection('a', 0.94), detection('b', 0.9)])
    expect(screen.getByRole('heading', { name: '2 loons detected' })).toBeInTheDocument()
  })

  it('renders the empty state when nothing was detected', () => {
    renderResult([])
    expect(screen.getByRole('heading', { name: 'No loon detected' })).toBeInTheDocument()
    expect(screen.queryByText('Highest confidence')).not.toBeInTheDocument()
  })

  it('renders one row per detection, in order', () => {
    const { container } = renderResult([
      detection('a', 0.9),
      detection('b', 0.8),
      detection('c', 0.7),
    ])

    const rows = Array.from(container.querySelectorAll('.detection-row'))
    expect(rows).toHaveLength(3)
    expect(rows.map((row) => row.querySelector('strong')?.textContent)).toEqual([
      '90%',
      '80%',
      '70%',
    ])
  })

  it('disables the save button once saved', () => {
    render(
      <DetectionResult
        result={makeResult([detection('a', 0.9)])}
        onCheckAnother={vi.fn()}
        onSave={vi.fn()}
        saved
      />,
    )
    expect(screen.getByRole('button', { name: /Saved to history/ })).toBeDisabled()
  })
})

/**
 * jsdom implements neither canvas nor image loading, so the download path has
 * to be stubbed at those seams. What is worth testing is the branching: does a
 * failure surface to the user, and does success stay quiet.
 */
function stubCanvas(toDataURL: () => string) {
  const context = {
    drawImage: vi.fn(),
    strokeRect: vi.fn(),
    fillText: vi.fn(),
    strokeStyle: '',
    fillStyle: '',
    lineWidth: 0,
    font: '',
  }
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    context as unknown as CanvasRenderingContext2D,
  )
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockImplementation(toDataURL)
  return context
}

/** Makes `new Image()` fire the given handler as soon as `src` is set. */
function stubImageLoad(event: 'onload' | 'onerror') {
  Object.defineProperty(HTMLImageElement.prototype, 'src', {
    configurable: true,
    set(this: HTMLImageElement) {
      const handler = this[event]
      // Async so the component's promise is still pending when it fires,
      // matching how a real image load resolves.
      setTimeout(() => {
        handler?.call(this, new Event(event.slice(2)))
      }, 0)
    },
  })
  Object.defineProperty(HTMLImageElement.prototype, 'naturalWidth', {
    configurable: true,
    get: () => 1000,
  })
  Object.defineProperty(HTMLImageElement.prototype, 'naturalHeight', {
    configurable: true,
    get: () => 800,
  })
}

afterEach(() => {
  vi.restoreAllMocks()
  // Reset the prototype patches so they cannot leak into other files.
  for (const property of ['src', 'naturalWidth', 'naturalHeight']) {
    Reflect.deleteProperty(HTMLImageElement.prototype, property)
  }
})

describe('downloading the annotated image', () => {
  it('draws every box onto a copy of the photo', async () => {
    const user = userEvent.setup()
    const context = stubCanvas(() => 'data:image/jpeg;base64,abc')
    stubImageLoad('onload')
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})

    renderResult([detection('a', 0.9), detection('b', 0.8)])
    await user.click(screen.getByRole('button', { name: /Download image/ }))

    await waitFor(() => expect(context.strokeRect).toHaveBeenCalledTimes(2))
    expect(context.drawImage).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('tells the user when the image cannot be exported', async () => {
    // A cross-origin image taints the canvas and toDataURL throws; the user
    // should get a message rather than a button that silently does nothing.
    const user = userEvent.setup()
    stubCanvas(() => {
      throw new Error('tainted canvas')
    })
    stubImageLoad('onload')
    vi.spyOn(console, 'error').mockImplementation(() => {})

    renderResult([detection('a', 0.9)])
    await user.click(screen.getByRole('button', { name: /Download image/ }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/could not/i)
  })

  it('tells the user when the image cannot be loaded', async () => {
    const user = userEvent.setup()
    stubImageLoad('onerror')

    renderResult([detection('a', 0.9)])
    await user.click(screen.getByRole('button', { name: /Download image/ }))

    expect(await screen.findByRole('alert')).toBeInTheDocument()
  })
})

describe('the helpfulness prompt', () => {
  it('records a positive answer', async () => {
    const user = userEvent.setup()
    renderResult([detection('a', 0.9)])

    const yes = screen.getByRole('button', { name: 'Yes' })
    expect(yes).toHaveAttribute('aria-pressed', 'false')

    await user.click(yes)

    expect(yes).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'No' })).toHaveAttribute('aria-pressed', 'false')
  })

  it('lets the answer be changed', async () => {
    const user = userEvent.setup()
    renderResult([detection('a', 0.9)])

    await user.click(screen.getByRole('button', { name: 'Yes' }))
    await user.click(screen.getByRole('button', { name: 'No' }))

    expect(screen.getByRole('button', { name: 'Yes' })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByRole('button', { name: 'No' })).toHaveAttribute('aria-pressed', 'true')
  })
})

describe('the details disclosure', () => {
  it('shows the file name and processing time', async () => {
    const user = userEvent.setup()
    renderResult([detection('a', 0.9)])

    await user.click(screen.getByText('View details'))

    expect(screen.getByText('photo.jpg')).toBeInTheDocument()
    expect(screen.getByText('1.1 seconds')).toBeInTheDocument()
  })

  it('shows how many loons were detected', async () => {
    const user = userEvent.setup()
    renderResult([detection('a', 0.9), detection('b', 0.8), detection('c', 0.7)])

    await user.click(screen.getByText('View details'))

    expect(screen.getByText('Loons detected')).toBeInTheDocument()
    expect(screen.getByText('Loons detected').nextElementSibling).toHaveTextContent('3')
  })
})
