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
import { strToU8, zipSync } from 'fflate'
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
function fakeCore({
  detections = 1,
  confirmAnswer = 'Clear history',
  // How many loons the detector finds in a file, by name.
  loonsIn = (_fileName: string) => detections,
} = {}) {
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
        return result(`r${nextId++}`, meta.fileName, loonsIn(meta.fileName), false)
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

describe('checking several images at once', () => {
  async function uploadMany(user: ReturnType<typeof userEvent.setup>, files: File[]) {
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    await user.upload(input, files)
  }

  function photos(...names: string[]) {
    return names.map((name) => photo(name))
  }

  it('checks every image, then saves the ones with loons', async () => {
    core = fakeCore({ loonsIn: (name) => (name === 'empty.jpg' ? 0 : 1) })
    const user = userEvent.setup()
    await renderApp()

    await uploadMany(user, photos('a.jpg', 'empty.jpg', 'c.jpg'))
    expect(await screen.findByRole('heading', { name: '3 images to check' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /Check 3 images/ }))
    expect(
      await screen.findByRole('heading', { name: 'Loons in 2 of 3 images' }),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /empty.jpg No loon detected/ })).toBeInTheDocument()
    // Nothing is stored until the reviewer decides.
    expect(core.saved).toHaveLength(0)

    await user.click(screen.getByRole('button', { name: /Save 2 with loons/ }))
    expect(await screen.findByRole('button', { name: /Saved to history/ })).toBeDisabled()
    expect(core.saved.map((row) => row.fileName)).toEqual(['c.jpg', 'a.jpg'])

    await user.click(historyNavButton())
    expect(await screen.findAllByText(/1 loon · 94% highest confidence/)).toHaveLength(2)
  })

  it('opens one image, saves it there, and goes back to the rest', async () => {
    const user = userEvent.setup()
    await renderApp()

    await uploadMany(user, photos('a.jpg', 'b.jpg'))
    await user.click(await screen.findByRole('button', { name: /Check 2 images/ }))
    await user.click(await screen.findByRole('button', { name: /a.jpg 1 loon/ }))

    expect(await screen.findByRole('heading', { name: '1 loon detected' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Save result/ }))
    expect(await screen.findByRole('button', { name: /Saved to history/ })).toBeDisabled()

    await user.click(screen.getByRole('button', { name: /Back to all images/ }))
    expect(screen.getByRole('button', { name: /a.jpg 1 loon · 94% · Saved/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Save 1 with loons/ })).toBeEnabled()
    expect(core.saved.map((row) => row.fileName)).toEqual(['a.jpg'])
  })

  it('unpacks a zip and sends each image on its own', async () => {
    const user = userEvent.setup()
    const calls = await renderApp()
    const zip = new File(
      [zipSync({ 'trip/one.jpg': strToU8('one'), 'trip/two.jpg': strToU8('two') })],
      'trip.zip',
      { type: 'application/zip' },
    )

    await uploadMany(user, [zip])
    await user.click(await screen.findByRole('button', { name: /Check 2 images/ }))
    await screen.findByRole('heading', { name: 'Loons in 2 of 2 images' })

    const sent = calls.mock.calls
      .filter(([command]) => command === 'detect')
      .map(([, body]) => unframe<{ fileName: string; contentType: string }>(body as Uint8Array))
    expect(sent.map(({ meta }) => meta)).toEqual([
      { fileName: 'one.jpg', contentType: 'image/jpeg' },
      { fileName: 'two.jpg', contentType: 'image/jpeg' },
    ])
    expect(sent.map(({ bytes }) => new TextDecoder().decode(bytes))).toEqual(['one', 'two'])
  })

  it('goes through the single check for one image, saying what it left out', async () => {
    const user = userEvent.setup({ applyAccept: false })
    await renderApp()

    await uploadMany(user, [
      photo('lake.jpg'),
      new File(['x'], 'notes.txt', { type: 'text/plain' }),
    ])

    expect(await screen.findByRole('button', { name: /Check for loons/ })).toBeInTheDocument()
    expect(screen.getByText("Left out 1 file Gavia can't check: notes.txt.")).toBeInTheDocument()
  })

  it('starts over from the uploader', async () => {
    const user = userEvent.setup()
    await renderApp()

    await uploadMany(user, photos('a.jpg', 'b.jpg'))
    await user.click(await screen.findByRole('button', { name: /Start over/ }))

    expect(screen.getByRole('heading', { name: /Is this a loon\?/ })).toBeInTheDocument()
  })

  it('returns to the batch from a saved check opened meanwhile', async () => {
    const user = userEvent.setup()
    await renderApp()
    await uploadAndCheck(user)
    await user.click(await screen.findByRole('button', { name: /Save result/ }))
    await waitFor(() => expect(core.saved).toHaveLength(1))
    await user.click(screen.getByRole('button', { name: /Check another/ }))

    await uploadMany(user, photos('a.jpg', 'b.jpg'))
    await screen.findByRole('heading', { name: '2 images to check' })
    await user.click(historyNavButton())
    await user.click(await screen.findByRole('button', { name: /1 loon · 94%/ }))
    await user.click(await screen.findByRole('button', { name: /Check another/ }))

    expect(screen.getByRole('heading', { name: '2 images to check' })).toBeInTheDocument()
  })
})

describe('when a batch runs into trouble', () => {
  async function checkBatchOf(names: string[]) {
    const user = userEvent.setup()
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    await user.upload(
      input,
      names.map((name) => photo(name)),
    )
    await user.click(await screen.findByRole('button', { name: /Check \d+ images/ }))
    return user
  }

  it('carries on past an image that cannot be read', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const handler: Handler = (command, payload) => {
      if (command === 'detect') {
        const { meta } = unframe<{ fileName: string }>(payload as Uint8Array)
        if (meta.fileName === 'bad.jpg') {
          rejectWith({ code: 'DECODE_FAILED', message: 'Could not read it.', status: 422 })
        }
      }
      return core.handler(command, payload)
    }
    await renderApp(handler)

    const user = await checkBatchOf(['a.jpg', 'bad.jpg', 'c.jpg'])

    expect(
      await screen.findByRole('heading', { name: 'Loons in 2 of 3 images' }),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /bad.jpg Could not read it/ })).toBeDisabled()

    // Checking again retries only what failed.
    routeCore(core.handler)
    await user.click(screen.getByRole('button', { name: /Check the remaining 1/ }))
    expect(
      await screen.findByRole('heading', { name: 'Loons in 3 of 3 images' }),
    ).toBeInTheDocument()
    expect(core.calls.filter((command) => command === 'detect')).toHaveLength(3)
  })

  it('stops at the first image when the model is unavailable', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await renderApp()
    const unavailable = vi.fn<Handler>(
      failingCore({
        code: 'MODEL_UNAVAILABLE',
        message: 'The detection model is not available. Please restart Gavia.',
        status: 503,
      }),
    )
    routeCore(unavailable)

    await checkBatchOf(['a.jpg', 'b.jpg', 'c.jpg'])

    expect(await screen.findByRole('alert')).toHaveTextContent(/restart Gavia/)
    expect(unavailable).toHaveBeenCalledTimes(1)
    expect(screen.getAllByRole('button', { name: /Waiting/ })).toHaveLength(2)
  })

  it('stops between images when asked', async () => {
    let release = () => {}
    const handler: Handler = async (command, payload) => {
      if (command === 'detect') await new Promise<void>((resolve) => (release = resolve))
      return core.handler(command, payload)
    }
    await renderApp(handler)

    const user = await checkBatchOf(['a.jpg', 'b.jpg', 'c.jpg'])
    await screen.findByRole('heading', { name: 'Checking 1 of 3' })
    await user.click(screen.getByRole('button', { name: /Stop/ }))
    expect(screen.getByRole('button', { name: /Stopping/ })).toBeDisabled()
    release()

    expect(
      await screen.findByRole('heading', { name: 'Loons in 1 of 1 image' }),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Check the remaining 2/ })).toBeEnabled()
    expect(core.calls.filter((command) => command === 'detect')).toHaveLength(1)
  })

  it('says how many results could not be saved', async () => {
    await renderApp()
    const user = await checkBatchOf(['a.jpg', 'b.jpg'])
    await screen.findByRole('heading', { name: 'Loons in 2 of 2 images' })

    vi.spyOn(console, 'error').mockImplementation(() => {})
    routeCore(failingCore({ code: 'INTERNAL_ERROR', message: 'disk full', status: 500 }))
    await user.click(screen.getByRole('button', { name: /Save 2 with loons/ }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      '2 results could not be saved. Please try again.',
    )
    expect(screen.getByRole('button', { name: /Save 2 with loons/ })).toBeEnabled()
  })

  it('says so when one result could not be saved', async () => {
    await renderApp()
    const user = await checkBatchOf(['a.jpg', 'b.jpg'])
    await screen.findByRole('heading', { name: 'Loons in 2 of 2 images' })

    vi.spyOn(console, 'error').mockImplementation(() => {})
    routeCore((command, payload) => {
      if (command === 'save_result') {
        const { meta } = unframe<StoredRow>(payload as Uint8Array)
        if (meta.fileName === 'b.jpg')
          rejectWith({ code: 'INTERNAL_ERROR', message: 'x', status: 500 })
      }
      return core.handler(command, payload)
    })
    await user.click(screen.getByRole('button', { name: /Save 2 with loons/ }))

    expect(await screen.findByRole('alert')).toHaveTextContent('1 result could not be saved.')
    expect(core.saved.map((row) => row.fileName)).toEqual(['a.jpg'])
  })

  it('reports a failed save from an opened image back in the batch', async () => {
    await renderApp()
    const user = await checkBatchOf(['a.jpg', 'b.jpg'])
    await user.click(await screen.findByRole('button', { name: /a.jpg 1 loon/ }))

    vi.spyOn(console, 'error').mockImplementation(() => {})
    routeCore(failingCore({ code: 'INTERNAL_ERROR', message: 'disk full', status: 500 }))
    await user.click(screen.getByRole('button', { name: /Save result/ }))
    await waitFor(() => expect(screen.getByRole('button', { name: /Save result/ })).toBeEnabled())

    await user.click(screen.getByRole('button', { name: /Back to all images/ }))
    expect(screen.getByRole('alert')).toHaveTextContent('This result could not be saved.')
  })
})
