import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BatchBusy, BatchItem } from '../types/batch'
import type { DetectionResult } from '../types/detection'
import { BatchPage } from './BatchPage'

const handlers = {
  onCheck: vi.fn(),
  onStop: vi.fn(),
  onSaveAll: vi.fn(),
  onStartOver: vi.fn(),
  onOpen: vi.fn(),
}

beforeEach(() => {
  Object.values(handlers).forEach((handler) => handler.mockReset())
})

function result(loons: number, saved = false): DetectionResult {
  return {
    id: 'r',
    imageUrl: 'blob:x',
    thumbnailUrl: '',
    fileName: 'x.jpg',
    fileSize: 1,
    detections: Array.from({ length: loons }, (_, i) => ({
      id: `d${i}`,
      label: 'Loon',
      confidence: 0.9 - i * 0.1,
      boundingBox: { x: 1, y: 1, width: 1, height: 1 },
    })),
    processingTime: 0.2,
    timestamp: '2026-09-28T10:00:00+00:00',
    imageWidth: 10,
    imageHeight: 10,
    modelName: 'loon_v1',
    tilesProcessed: 1,
    saved,
  }
}

function item(name: string, overrides: Partial<BatchItem> = {}): BatchItem {
  return {
    key: name,
    file: new File(['x'], name, { type: 'image/jpeg' }),
    previewUrl: 'blob:x',
    status: 'waiting',
    ...overrides,
  }
}

function renderPage(items: BatchItem[], busy: BatchBusy = null, extra = {}) {
  return render(<BatchPage items={items} busy={busy} notice="" error="" {...handlers} {...extra} />)
}

const waiting = () => [item('a.jpg'), item('b.jpg'), item('c.jpg')]

describe('before checking', () => {
  it('says how many images there are and offers to check them all', async () => {
    const user = userEvent.setup()
    renderPage(waiting())

    expect(screen.getByRole('heading', { name: '3 images to check' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Check 3 images/ }))

    expect(handlers.onCheck).toHaveBeenCalledTimes(1)
  })

  it('shows every image, waiting and not yet openable', () => {
    renderPage(waiting())

    const cards = screen.getAllByRole('button', { name: /Waiting/ })
    expect(cards).toHaveLength(3)
    cards.forEach((card) => expect(card).toBeDisabled())
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
  })

  it('offers to start over', async () => {
    const user = userEvent.setup()
    renderPage(waiting())

    await user.click(screen.getByRole('button', { name: /Start over/ }))

    expect(handlers.onStartOver).toHaveBeenCalledTimes(1)
  })

  it('shows what was left out when the images were chosen', () => {
    renderPage(waiting(), null, { notice: "Left out 1 file Gavia can't check: notes.txt." })
    expect(screen.getByText(/Left out 1 file/)).toBeInTheDocument()
  })
})

describe('while checking', () => {
  const running = () => [
    item('a.jpg', { status: 'done', result: result(2) }),
    item('b.jpg', { status: 'checking' }),
    item('c.jpg'),
  ]

  it('counts the image being checked and shows progress', () => {
    renderPage(running(), 'checking')

    expect(screen.getByRole('heading', { name: 'Checking 2 of 3' })).toBeInTheDocument()
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '1')
    expect(screen.getByRole('button', { name: /b.jpg Checking…/ })).toBeDisabled()
  })

  it('lets a checked image be opened already', async () => {
    const user = userEvent.setup()
    renderPage(running(), 'checking')

    await user.click(screen.getByRole('button', { name: /a.jpg 2 loons · 90%/ }))

    expect(handlers.onOpen).toHaveBeenCalledWith('a.jpg')
  })

  it('can be stopped, and says it is stopping', async () => {
    const user = userEvent.setup()
    const { rerender } = renderPage(running(), 'checking')

    await user.click(screen.getByRole('button', { name: /Stop/ }))
    expect(handlers.onStop).toHaveBeenCalledTimes(1)

    rerender(<BatchPage items={running()} busy="stopping" notice="" error="" {...handlers} />)
    expect(screen.getByRole('button', { name: /Stopping/ })).toBeDisabled()
  })

  it('cannot start over or save until it finishes', () => {
    renderPage(running(), 'checking')

    expect(screen.getByRole('button', { name: /Start over/ })).toBeDisabled()
    expect(screen.getByRole('button', { name: /Save 1 with loons/ })).toBeDisabled()
  })
})

describe('once checked', () => {
  const finished = () => [
    item('a.jpg', { status: 'done', result: result(2) }),
    item('b.jpg', { status: 'done', result: result(0) }),
    item('c.jpg', { status: 'failed', error: 'This image could not be read.' }),
  ]

  it('sums up, with the failure shown against its image', () => {
    renderPage(finished())

    expect(screen.getByRole('heading', { name: 'Loons in 1 of 3 images' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /b.jpg No loon detected/ })).toBeEnabled()
    expect(
      screen.getByRole('button', { name: /c.jpg This image could not be read/ }),
    ).toBeDisabled()
  })

  it('offers to check again what failed', async () => {
    const user = userEvent.setup()
    renderPage(finished())

    await user.click(screen.getByRole('button', { name: /Check the remaining 1/ }))

    expect(handlers.onCheck).toHaveBeenCalledTimes(1)
  })

  it('offers to save the images with loons', async () => {
    const user = userEvent.setup()
    renderPage(finished())

    await user.click(screen.getByRole('button', { name: /Save 1 with loons/ }))

    expect(handlers.onSaveAll).toHaveBeenCalledTimes(1)
  })

  it('says when they are saving and when they are saved', () => {
    const { rerender } = renderPage(finished(), 'saving')
    expect(screen.getByRole('button', { name: /Saving…/ })).toBeDisabled()

    const saved = [item('a.jpg', { status: 'done', result: result(1, true) })]
    rerender(<BatchPage items={saved} busy={null} notice="" error="" {...handlers} />)
    expect(screen.getByRole('button', { name: /Saved to history/ })).toBeDisabled()
    expect(screen.getByRole('button', { name: /a.jpg 1 loon · 90% · Saved/ })).toBeEnabled()
    expect(screen.queryByRole('button', { name: /Check/ })).not.toBeInTheDocument()
  })

  it('offers no save when no image had a loon', () => {
    renderPage([item('b.jpg', { status: 'done', result: result(0) })])
    expect(screen.queryByRole('button', { name: /Save/ })).not.toBeInTheDocument()
  })

  it('shows an error as an alert', () => {
    renderPage(finished(), null, { error: '1 result could not be saved. Please try again.' })
    expect(screen.getByRole('alert')).toHaveTextContent('1 result could not be saved')
  })

  it('still says something for a failure with no message', () => {
    renderPage([item('a.jpg', { status: 'failed' })])
    expect(screen.getByRole('button', { name: /Could not be checked/ })).toBeDisabled()
  })

  it('speaks of one image in the singular', () => {
    renderPage([item('a.jpg', { status: 'done', result: result(1) }), item('b.jpg')])
    expect(screen.getByRole('heading', { name: 'Loons in 1 of 1 image' })).toBeInTheDocument()
  })
})
