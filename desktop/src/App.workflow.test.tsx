/**
 * The whole app against a fake core.
 *
 * Where App.test.tsx mocks the service modules, this mocks only Tauri's IPC —
 * so the real `api.ts`, `detectionService.ts` and `historyService.ts` all run,
 * against replies shaped exactly like the ones `src-tauri/src/service.rs`
 * returns (pinned on the Rust side by `src-tauri/tests/workflow.rs`).
 *
 * These are the tests that would catch the UI and the core drifting apart.
 */

import { clearMocks, mockIPC, mockWindows } from '@tauri-apps/api/mocks'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { unframe } from './services/api'

interface StoredRow {
  id: string
  fileName: string
  detections: unknown[]
}

type Handler = (command: string, payload?: unknown) => unknown

/** The core rejects with plain `{ code, message, status }` objects, not Errors. */
function rejectWith(value: unknown): never {
  throw value
}

/** A minimal in-memory stand-in for the core's detect/save/history commands. */
function fakeCore({ detections = 1, confirmAnswer = 'Clear history' } = {}) {
  const saved: StoredRow[] = []
  const calls: string[] = []
  let nextId = 0

  function detectionList(count: number, prefix: string) {
    return Array.from({ length: count }, (_, index) => ({
      id: `${prefix}-${index}`,
      label: 'Loon',
      confidence: 0.94 - index * 0.1,
      boundingBox: { x: 10 + index * 20, y: 15, width: 18, height: 22 },
    }))
  }

  function result(id: string, fileName: string, count: number, isSaved: boolean) {
    return {
      id,
      imageUrl: isSaved ? `gavia://localhost/results/${id}/image` : '',
      thumbnailUrl: isSaved ? `gavia://localhost/results/${id}/thumb` : '',
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

  const handler = vi.fn<Handler>((command, payload) => {
    calls.push(command)
    switch (command) {
      case 'detect': {
        const { meta } = unframe<{ fileName: string }>(payload as Uint8Array)
        return result(`r${nextId++}`, meta.fileName, detections, false)
      }
      case 'save_result': {
        const { meta } = unframe<StoredRow>(payload as Uint8Array)
        if (saved.some((row) => row.id === meta.id)) {
          rejectWith({ code: 'ALREADY_SAVED', message: 'Already saved.', status: 409 })
        }
        saved.unshift(meta)
        return result(meta.id, meta.fileName, meta.detections.length, true)
      }
      case 'list_results':
        return saved.map((row) => result(row.id, row.fileName, row.detections.length, true))
      // Theming the native window; nothing to fake.
      case 'plugin:window|set_theme':
        return null
      // The native "are you sure?" dialog; answers with the label clicked.
      case 'plugin:dialog|message':
        return confirmAnswer
      case 'clear_results': {
        const deleted = saved.length
        saved.length = 0
        return { deleted }
      }
      default:
        return rejectWith({ code: 'NOT_FOUND', message: `no command ${command}`, status: 404 })
    }
  })

  return { handler, saved, calls }
}

/** Route IPC to a handler; swapping handlers mid-test simulates the core changing. */
function routeCore(handler: Handler) {
  mockWindows('main')
  mockIPC((command, payload) => handler(command, payload))
}

/** A core that rejects everything with one error. */
function failingCore(error: unknown): Handler {
  return () => rejectWith(error)
}

let core: ReturnType<typeof fakeCore>

beforeEach(() => {
  core = fakeCore()
  routeCore(core.handler)
})

afterEach(() => {
  clearMocks()
  // clearMocks leaves an empty __TAURI_INTERNALS__ behind, which would make
  // inApp() true for whatever runs next.
  delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
  vi.restoreAllMocks()
})

function photo(name = 'loon.jpg') {
  return new File(['image-bytes'], name, { type: 'image/jpeg' })
}

/**
 * Render and wait for the initial history load to settle.
 *
 * App loads history in an effect on mount. Interacting before that resolves
 * lets the resulting state update land outside act(), which React warns about
 * and which can interleave unpredictably with the assertions.
 */
async function renderApp(handler: Handler = core.handler) {
  const history = vi.fn<Handler>((command, payload) => handler(command, payload))
  routeCore(history)
  render(<App />)
  await waitFor(() =>
    expect(history.mock.calls.map(([command]) => command)).toContain('list_results'),
  )
  return history
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
    expect(core.saved).toHaveLength(0)

    // 3. Keep it.
    await user.click(screen.getByRole('button', { name: /Save result/ }))
    await waitFor(() => expect(core.saved).toHaveLength(1))
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
    await waitFor(() => expect(core.saved).toHaveLength(1))

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
    await waitFor(() => expect(core.saved).toHaveLength(1))

    await user.click(historyNavButton())
    await user.click(await screen.findByRole('button', { name: /Clear history/ }))

    await waitFor(() => expect(core.saved).toHaveLength(0))
    expect(await screen.findByText(/No saved checks yet/)).toBeInTheDocument()
  })

  it('keeps the history when the reviewer cancels clearing it', async () => {
    core = fakeCore({ confirmAnswer: 'Cancel' })
    const user = userEvent.setup()
    await renderApp()

    await uploadAndCheck(user)
    await screen.findByRole('heading', { name: '1 loon detected' })
    await user.click(screen.getByRole('button', { name: /Save result/ }))
    await waitFor(() => expect(core.saved).toHaveLength(1))

    await user.click(historyNavButton())
    await user.click(await screen.findByRole('button', { name: /Clear history/ }))

    await waitFor(() => expect(core.calls).toContain('plugin:dialog|message'))
    expect(core.calls).not.toContain('clear_results')
    expect(core.saved).toHaveLength(1)
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

    expect(core.saved.map((row) => row.fileName)).toEqual(['second.jpg', 'first.jpg'])
  })
})

describe('what the reviewer sees', () => {
  it('draws a box per detection over the image', async () => {
    core = fakeCore({ detections: 3 })
    const user = userEvent.setup()
    await renderApp()

    await uploadAndCheck(user)
    await screen.findByRole('heading', { name: '3 loons detected' })

    expect(document.querySelectorAll('.detection-box')).toHaveLength(3)
  })

  it('reports a photo with no loons as a clear result, not an error', async () => {
    core = fakeCore({ detections: 0 })
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

    // The core returns imageUrl: "" for an unsaved result, so the app has
    // to fall back to the object URL it already made for the preview.
    const image = document.querySelector('.annotation-frame img')
    expect(image?.getAttribute('src')).toMatch(/^blob:/)
  })
})

describe('when the core misbehaves', () => {
  it('passes through an actionable rejection', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const user = userEvent.setup()
    await renderApp()
    routeCore(
      failingCore({
        code: 'IMAGE_TOO_LARGE',
        message: 'Please choose a smaller image.',
        status: 413,
      }),
    )

    await uploadAndCheck(user)

    expect(await screen.findByRole('alert')).toHaveTextContent('Please choose a smaller image.')
  })

  it('explains an unavailable model', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const user = userEvent.setup()
    await renderApp()
    routeCore(
      failingCore({
        code: 'MODEL_UNAVAILABLE',
        message: 'The detection model is not available. Please restart Gavia.',
        status: 503,
      }),
    )

    await uploadAndCheck(user)

    expect(await screen.findByRole('alert')).toHaveTextContent(/restart Gavia/)
  })

  it('hides an internal error behind a generic message', async () => {
    // An internal error's message is not something a reviewer can act on.
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const user = userEvent.setup()
    await renderApp()
    routeCore(failingCore({ code: 'INTERNAL_ERROR', message: 'disk on fire', status: 500 }))

    await uploadAndCheck(user)

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/Something went wrong while checking this image/)
    expect(alert).not.toHaveTextContent(/disk on fire/)
  })

  it('treats a broken IPC bridge as an internal error', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const user = userEvent.setup()
    await renderApp()
    routeCore(failingCore(new Error('command detect not found')))

    await uploadAndCheck(user)

    expect(await screen.findByRole('alert')).toHaveTextContent(/Something went wrong/)
  })

  it('keeps the result on screen when a save fails', async () => {
    const user = userEvent.setup()
    await renderApp()

    await uploadAndCheck(user)
    await screen.findByRole('heading', { name: '1 loon detected' })

    // Fail only the save.
    vi.spyOn(console, 'error').mockImplementation(() => {})
    routeCore(failingCore({ code: 'INTERNAL_ERROR', message: 'disk full', status: 500 }))

    await user.click(screen.getByRole('button', { name: /Save result/ }))

    await waitFor(() => expect(screen.getByRole('button', { name: /Save result/ })).toBeEnabled())
    expect(screen.getByRole('heading', { name: '1 loon detected' })).toBeInTheDocument()
  })

  it('lets the user retry after a failed check', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const user = userEvent.setup()
    await renderApp()
    routeCore(failingCore({ code: 'DECODE_FAILED', message: 'Could not read it.', status: 422 }))

    await uploadAndCheck(user)
    await screen.findByRole('alert')

    // The core recovers; the same file should check successfully.
    routeCore(core.handler)
    await user.click(screen.getByRole('button', { name: /Check for loons/ }))

    expect(await screen.findByRole('heading', { name: '1 loon detected' })).toBeInTheDocument()
  })

  it('sends the file name and type along with the bytes', async () => {
    const user = userEvent.setup()
    const calls = await renderApp()

    await uploadAndCheck(user, photo('lake.jpg'))
    await screen.findByRole('heading', { name: '1 loon detected' })

    const detect = calls.mock.calls.find(([command]) => command === 'detect')
    const { meta, bytes } = unframe<{ fileName: string; contentType: string }>(
      detect?.[1] as Uint8Array,
    )
    expect(meta).toEqual({ fileName: 'lake.jpg', contentType: 'image/jpeg' })
    expect(new TextDecoder().decode(bytes)).toBe('image-bytes')
  })
})
