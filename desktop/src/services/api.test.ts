import { clearMocks, mockIPC } from '@tauri-apps/api/mocks'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { previewCall } from '../dev/browserPreview'
import { ApiError, call, frame, inApp, unframe } from './api'

/** Reject the way the core does: with a plain object, not an Error. */
function rejectWith(value: unknown): never {
  throw value
}

vi.mock('../dev/browserPreview', () => ({ previewCall: vi.fn() }))

const previewCallMock = vi.mocked(previewCall)

function leaveApp() {
  delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
}

afterEach(() => {
  clearMocks()
  // clearMocks empties the internals object but leaves it on `window`, which
  // would still read as "inside the app".
  leaveApp()
  previewCallMock.mockReset()
})

describe('inApp', () => {
  it('is false in a plain browser', () => {
    expect(inApp()).toBe(false)
  })

  it('is true once the Tauri internals are present', () => {
    mockIPC(() => null)
    expect(inApp()).toBe(true)
  })
})

describe('call inside the app', () => {
  it('invokes the named command with its arguments and returns the result', async () => {
    const handler = vi.fn((_cmd: string, _payload?: unknown) => ({ ok: true }))
    mockIPC(handler)

    await expect(call('delete_result', { id: 'abc' })).resolves.toEqual({ ok: true })
    expect(handler).toHaveBeenCalledWith('delete_result', { id: 'abc' })
  })

  it('passes a binary body through untouched', async () => {
    let received: unknown
    mockIPC((_cmd, payload) => {
      received = payload
      return null
    })
    const body = new Uint8Array([1, 2, 3])

    await call('detect', body)

    expect(received).toBe(body)
  })

  it('never falls back to the browser preview', async () => {
    mockIPC(() => 'from the core')
    await expect(call('list_results')).resolves.toBe('from the core')
    expect(previewCallMock).not.toHaveBeenCalled()
  })
})

describe('call in a plain browser', () => {
  it('is answered by the browser preview', async () => {
    previewCallMock.mockResolvedValue(['preview'])
    const body = new Uint8Array([9])

    await expect(call('list_results', body)).resolves.toEqual(['preview'])
    expect(previewCallMock).toHaveBeenCalledWith('list_results', body)
  })

  it('rethrows an ApiError from the preview as-is', async () => {
    const error = new ApiError('UNSUPPORTED_FORMAT', 'Not that.', 415)
    previewCallMock.mockRejectedValue(error)

    await expect(call('detect')).rejects.toBe(error)
  })
})

describe('error mapping', () => {
  it('turns the core error shape into a typed ApiError', async () => {
    mockIPC(() =>
      rejectWith({ code: 'IMAGE_TOO_LARGE', message: 'Too big.', status: 413, requestId: 'req-1' }),
    )

    const error = await call('detect').catch((e: unknown) => e)

    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({
      code: 'IMAGE_TOO_LARGE',
      message: 'Too big.',
      status: 413,
      requestId: 'req-1',
    })
  })

  it('defaults a missing status to 0', async () => {
    mockIPC(() => rejectWith({ code: 'DECODE_FAILED', message: 'Not readable.' }))
    await expect(call('detect')).rejects.toMatchObject({ code: 'DECODE_FAILED', status: 0 })
  })

  it('rethrows an ApiError unchanged', async () => {
    const original = new ApiError('ALREADY_SAVED', 'Already there.', 409, 'req-2')
    mockIPC(() => rejectWith(original))
    await expect(call('save_result')).rejects.toBe(original)
  })

  it.each([
    ['a plain Error', new Error('command not found')],
    ['a string', 'command detect not found'],
    ['null', null],
    ['an object missing a message', { code: 'X' }],
  ])('turns %s into INTERNAL_ERROR', async (_label, rejection) => {
    // A rejection that is not the core's shape never reached a command, so
    // there is nothing the reviewer can do about it.
    mockIPC(() => rejectWith(rejection))

    await expect(call('detect')).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
      message: 'Something went wrong inside Gavia.',
      status: 0,
    })
  })

  it('is an Error, so it survives normal error handling', async () => {
    mockIPC(() => rejectWith({ code: 'X', message: 'y', status: 500 }))
    const error = await call('detect').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).name).toBe('ApiError')
  })
})

describe('frame and unframe', () => {
  it('round-trips the metadata and the file bytes', async () => {
    const meta = { fileName: 'loon.jpg', contentType: 'image/jpeg', note: 'huard ✓' }
    const file = new File([new Uint8Array([0xff, 0xd8, 0x00, 0x7f])], 'loon.jpg')

    const { meta: decoded, bytes } = unframe<typeof meta>(await frame(meta, file))

    expect(decoded).toEqual(meta)
    expect([...bytes]).toEqual([0xff, 0xd8, 0x00, 0x7f])
  })

  it('leads with the JSON length as a little-endian u32', async () => {
    // The Rust side reads exactly this layout; see `unframe` in service.rs.
    const meta = { a: 1 }
    const json = new TextEncoder().encode(JSON.stringify(meta))
    const body = await frame(meta, new Blob([new Uint8Array([7, 8])]))

    expect(body.length).toBe(4 + json.length + 2)
    expect([...body.subarray(0, 4)]).toEqual([json.length, 0, 0, 0])
    expect(new TextDecoder().decode(body.subarray(4, 4 + json.length))).toBe('{"a":1}')
    expect([...body.subarray(4 + json.length)]).toEqual([7, 8])
  })

  it('encodes lengths over 255 across several bytes', async () => {
    const meta = { pad: 'x'.repeat(300) }
    const length = new TextEncoder().encode(JSON.stringify(meta)).length
    const body = await frame(meta, new Blob([]))

    expect(body[0]).toBe(length & 0xff)
    expect(body[1]).toBe((length >> 8) & 0xff)
    expect(body[2]).toBe(0)
    expect(body[3]).toBe(0)
    expect(unframe<typeof meta>(body).bytes).toHaveLength(0)
  })

  it('unframes a view that does not start at the beginning of its buffer', async () => {
    const framed = await frame({ ok: true }, new Blob([new Uint8Array([5])]))
    const padded = new Uint8Array(framed.length + 3)
    padded.set(framed, 3)

    const { meta, bytes } = unframe<{ ok: boolean }>(padded.subarray(3))

    expect(meta).toEqual({ ok: true })
    expect([...bytes]).toEqual([5])
  })

  it('reads the file through FileReader when Blob.arrayBuffer is missing', async () => {
    const blob = new Blob([new Uint8Array([1, 2, 3])])
    Object.defineProperty(blob, 'arrayBuffer', { value: undefined })

    const { bytes } = unframe(await frame({}, blob))

    expect([...bytes]).toEqual([1, 2, 3])
  })

  it('rejects when FileReader fails', async () => {
    const blob = new Blob([new Uint8Array([1])])
    Object.defineProperty(blob, 'arrayBuffer', { value: undefined })
    const failure = new DOMException('unreadable')
    const readSpy = vi
      .spyOn(FileReader.prototype, 'readAsArrayBuffer')
      .mockImplementation(function (this: FileReader) {
        Object.defineProperty(this, 'error', { value: failure })
        this.onerror?.(new ProgressEvent('error') as ProgressEvent<FileReader>)
      })

    await expect(frame({}, blob)).rejects.toBe(failure)
    readSpy.mockRestore()
  })

  it('rejects with a fallback error when FileReader reports none', async () => {
    const blob = new Blob([new Uint8Array([1])])
    Object.defineProperty(blob, 'arrayBuffer', { value: undefined })
    const readSpy = vi
      .spyOn(FileReader.prototype, 'readAsArrayBuffer')
      .mockImplementation(function (this: FileReader) {
        Object.defineProperty(this, 'error', { value: null })
        this.onerror?.(new ProgressEvent('error') as ProgressEvent<FileReader>)
      })

    await expect(frame({}, blob)).rejects.toThrow('Could not read the file.')
    readSpy.mockRestore()
  })
})
