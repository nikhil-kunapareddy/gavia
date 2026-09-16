/**
 * The whole app against a fake backend.
 *
 * Where App.test.tsx mocks the service modules, this mocks only `fetch` — so
 * the real `api.ts`, `detectionService.ts` and `historyService.ts` all run,
 * against responses shaped exactly like the ones the FastAPI backend returns
 * (the shapes are pinned by backend/tests/test_api.py).
 *
 * These are the tests that would catch the app and the API drifting apart.
 */

import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'

interface StoredRow {
  id: string
  fileName: string
  detections: unknown[]
}

/** A minimal in-memory stand-in for the backend's detect/save/history routes. */
function fakeBackend({ detections = 1 } = {}) {
  const saved: StoredRow[] = []
  let nextId = 0

  function detectionList(count: number, prefix: string) {
    return Array.from({ length: count }, (_, index) => ({
      id: `${prefix}-${index}`,
      label: 'Loon',
      confidence: 0.94 - index * 0.1,
      boundingBox: { x: 10 + index * 20, y: 15, width: 18, height: 22 },
    }))
  }

  function resultBody(id: string, fileName: string, count: number, isSaved: boolean) {
    return {
      id,
      imageUrl: isSaved ? `/api/results/${id}/image` : '',
      fileName,
      fileSize: 2048,
      detections: detectionList(count, id),
      processingTime: 0.18,
      timestamp: '2026-09-09T10:00:00+00:00',
      imageWidth: 4282,
      imageHeight: 2335,
      modelName: 'loon_v1',
      tilesProcessed: 1,
      saved: isSaved,
    }
  }

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })

  const handler = vi.fn((path: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET'

    if (path === '/api/detect' && method === 'POST') {
      const file = (init.body as FormData).get('image') as File
      return json(resultBody(`r${nextId++}`, file.name, detections, false))
    }

    if (path === '/api/results' && method === 'POST') {
      const payload = JSON.parse((init.body as FormData).get('result') as string) as StoredRow
      if (saved.some((row) => row.id === payload.id)) {
        return json({ error: { code: 'ALREADY_SAVED', message: 'Already saved.' } }, 409)
      }
      saved.unshift(payload)
      return json(
        resultBody(payload.id, payload.fileName, payload.detections.length, true),
        201,
      )
    }

    if (path === '/api/results' && method === 'GET') {
      return json(
        saved.map((row) => resultBody(row.id, row.fileName, row.detections.length, true)),
      )
    }

    if (path === '/api/results' && method === 'DELETE') {
      const count = saved.length
      saved.length = 0
      return json({ deleted: count })
    }

    return json({ error: { code: 'NOT_FOUND', message: 'no route' } }, 404)
  })

  return { handler, saved }
}

let backend: ReturnType<typeof fakeBackend>

beforeEach(() => {
  backend = fakeBackend()
  vi.stubGlobal('fetch', backend.handler)
  vi.spyOn(window, 'confirm').mockReturnValue(true)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function photo(name = 'loon.jpg') {
  return new File(['image-bytes'], name, { type: 'image/jpeg' })
}

/**
 * Render and wait for the initial history fetch to settle.
 *
 * App loads history in an effect on mount. Interacting before that resolves
 * lets the resulting state update land outside act(), which React warns about
 * and which can interleave unpredictably with the assertions.
 */
async function renderApp() {
  render(<App />)
  await waitFor(() =>
    expect(vi.mocked(fetch)).toHaveBeenCalledWith('/api/results', expect.anything()),
  )
}

async function uploadAndCheck(user: ReturnType<typeof userEvent.setup>, file = photo()) {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement
  await user.upload(input, file)
  await user.click(await screen.findByRole('button', { name: /Check for loons/ }))
}

function historyNavButton() {
  return within(screen.getByRole('navigation')).getByRole('button', {
    name: /Previous checks/,
  })
}

describe('the full check-and-keep journey', () => {
  it('carries a photo from upload to saved history', async () => {
    const user = userEvent.setup()
    await renderApp()

    // 1. Check a photo.
    await uploadAndCheck(user)
    expect(await screen.findByRole('heading', { name: '1 loon detected' })).toBeInTheDocument()

    // 2. Nothing is stored until the reviewer decides.
    expect(backend.saved).toHaveLength(0)

    // 3. Keep it.
    await user.click(screen.getByRole('button', { name: /Save result/ }))
    await waitFor(() => expect(backend.saved).toHaveLength(1))
    expect(await screen.findByRole('button', { name: /Saved to history/ })).toBeDisabled()

    // 4. It appears in the history.
    await user.click(historyNavButton())
    expect(await screen.findByText(/1 loon · 94% highest confidence/)).toBeInTheDocument()
  })

  it('reopens a saved check from the history', async () => {
    const user = userEvent.setup()
    await renderApp()

    await uploadAndCheck(user)
    await screen.findByRole('heading', { name: '1 loon detected' })
    await user.click(screen.getByRole('button', { name: /Save result/ }))
    await waitFor(() => expect(backend.saved).toHaveLength(1))

    await user.click(historyNavButton())
    // A history card's accessible name is its whole summary line.
    await user.click(await screen.findByRole('button', { name: /1 loon · 94%/ }))

    // Reopened from the server, so it is already saved and cannot be re-saved.
    expect(await screen.findByRole('heading', { name: '1 loon detected' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Saved to history/ })).toBeDisabled()
  })

  it('clears the history', async () => {
    const user = userEvent.setup()
    await renderApp()

    await uploadAndCheck(user)
    await screen.findByRole('heading', { name: '1 loon detected' })
    await user.click(screen.getByRole('button', { name: /Save result/ }))
    await waitFor(() => expect(backend.saved).toHaveLength(1))

    await user.click(historyNavButton())
    await user.click(await screen.findByRole('button', { name: /Clear history/ }))

    await waitFor(() => expect(backend.saved).toHaveLength(0))
    expect(await screen.findByText(/No saved checks yet/)).toBeInTheDocument()
  })

  it('checks several photos in a row', async () => {
    const user = userEvent.setup()
    await renderApp()

    for (const name of ['first.jpg', 'second.jpg']) {
      await uploadAndCheck(user, photo(name))
      await screen.findByRole('heading', { name: '1 loon detected' })
      await user.click(screen.getByRole('button', { name: /Save result/ }))
      await waitFor(() =>
        expect(screen.getByRole('button', { name: /Saved to history/ })).toBeInTheDocument(),
      )
      await user.click(screen.getByRole('button', { name: /Check another/ }))
    }

    expect(backend.saved.map((row) => row.fileName)).toEqual(['second.jpg', 'first.jpg'])
  })
})

describe('what the reviewer sees', () => {
  it('draws a box per detection over the image', async () => {
    backend = fakeBackend({ detections: 3 })
    vi.stubGlobal('fetch', backend.handler)
    const user = userEvent.setup()
    await renderApp()

    await uploadAndCheck(user)
    await screen.findByRole('heading', { name: '3 loons detected' })

    expect(document.querySelectorAll('.detection-box')).toHaveLength(3)
  })

  it('reports a photo with no loons as a clear result, not an error', async () => {
    backend = fakeBackend({ detections: 0 })
    vi.stubGlobal('fetch', backend.handler)
    const user = userEvent.setup()
    await renderApp()

    await uploadAndCheck(user)

    expect(await screen.findByRole('heading', { name: /No loon detected/i })).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('shows the preview image before anything is saved', async () => {
    const user = userEvent.setup()
    await renderApp()

    await uploadAndCheck(user)
    await screen.findByRole('heading', { name: '1 loon detected' })

    // The backend returns imageUrl: "" for an unsaved result, so the app has
    // to fall back to the object URL it already made for the preview.
    const image = document.querySelector('.annotation-frame img')
    expect(image?.getAttribute('src')).toMatch(/^blob:/)
  })
})

describe('when the backend misbehaves', () => {
  it('explains an unreachable backend instead of a generic failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))),
    )
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const user = userEvent.setup()
    await renderApp()

    await uploadAndCheck(user)

    expect(await screen.findByRole('alert')).toHaveTextContent(/Could not reach/)
  })

  it('passes through an actionable rejection from the server', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              error: { code: 'IMAGE_TOO_LARGE', message: 'Please choose a smaller image.' },
            }),
            { status: 413, headers: { 'content-type': 'application/json' } },
          ),
        ),
      ),
    )
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const user = userEvent.setup()
    await renderApp()

    await uploadAndCheck(user)

    expect(await screen.findByRole('alert')).toHaveTextContent('Please choose a smaller image.')
  })

  it('hides an internal error behind a generic message', async () => {
    // A 500's message is not something a reviewer can act on.
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              error: { code: 'INTERNAL_ERROR', message: 'Something went wrong.' },
            }),
            { status: 500, headers: { 'content-type': 'application/json' } },
          ),
        ),
      ),
    )
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const user = userEvent.setup()
    await renderApp()

    await uploadAndCheck(user)

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /Something went wrong while checking this image/,
    )
  })

  it('keeps the result on screen when a save fails', async () => {
    const user = userEvent.setup()
    await renderApp()

    await uploadAndCheck(user)
    await screen.findByRole('heading', { name: '1 loon detected' })

    // Fail only the save.
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))),
    )

    await user.click(screen.getByRole('button', { name: /Save result/ }))

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Save result/ })).toBeEnabled(),
    )
    expect(screen.getByRole('heading', { name: '1 loon detected' })).toBeInTheDocument()
  })

  it('lets the user retry after a failed check', async () => {
    const failing = vi.fn(() => Promise.reject(new TypeError('Failed to fetch')))
    vi.stubGlobal('fetch', failing)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const user = userEvent.setup()
    await renderApp()

    await uploadAndCheck(user)
    await screen.findByRole('alert')

    // Backend comes back; the same file should check successfully.
    vi.stubGlobal('fetch', backend.handler)
    await user.click(screen.getByRole('button', { name: /Check for loons/ }))

    expect(await screen.findByRole('heading', { name: '1 loon detected' })).toBeInTheDocument()
  })
})
