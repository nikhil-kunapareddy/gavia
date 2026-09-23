import { clearMocks, mockIPC } from '@tauri-apps/api/mocks'
import { afterEach, describe, expect, it } from 'vitest'
import { unframe } from './api'
import { analyzeImage } from './detectionService'

/** Reject the way the core does: with a plain object, not an Error. */
function rejectWith(value: unknown): never {
  throw value
}

afterEach(() => {
  clearMocks()
  delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
})

function detectionResult(overrides = {}) {
  return {
    id: 'abc',
    imageUrl: '',
    thumbnailUrl: '',
    fileName: 'loon.jpg',
    fileSize: 2048,
    detections: [
      {
        id: 'abc-0',
        label: 'Loon',
        confidence: 0.91,
        boundingBox: { x: 12, y: 24, width: 30, height: 18 },
      },
    ],
    processingTime: 0.18,
    timestamp: '2026-09-09T10:00:00+00:00',
    imageWidth: 4282,
    imageHeight: 2335,
    modelName: 'loon_v1',
    tilesProcessed: 1,
    saved: false,
    ...overrides,
  }
}

/** Answer `detect` with `response`, recording what the command was sent. */
function mockDetect(response: unknown = detectionResult()) {
  const calls: { cmd: string; payload: unknown }[] = []
  mockIPC((cmd, payload) => {
    calls.push({ cmd, payload })
    return response
  })
  return calls
}

describe('analyzeImage', () => {
  it('sends the file as a framed binary body to the detect command', async () => {
    const calls = mockDetect()
    const file = new File(['bytes'], 'loon.jpg', { type: 'image/jpeg' })

    await analyzeImage(file)

    expect(calls).toHaveLength(1)
    expect(calls[0].cmd).toBe('detect')
    expect(calls[0].payload).toBeInstanceOf(Uint8Array)
    const { meta, bytes } = unframe(calls[0].payload as Uint8Array)
    expect(meta).toEqual({ fileName: 'loon.jpg', contentType: 'image/jpeg' })
    expect(new TextDecoder().decode(bytes)).toBe('bytes')
  })

  it('returns the detections in the shape the overlay draws', async () => {
    mockDetect()

    const result = await analyzeImage(new File([''], 'loon.jpg'))

    expect(result.detections[0].boundingBox).toEqual({
      x: 12,
      y: 24,
      width: 30,
      height: 18,
    })
    expect(result.imageWidth).toBe(4282)
  })

  it('comes back unsaved with no image URL', async () => {
    // Detection is a preview; nothing is kept until the reviewer saves it, so
    // the caller has to supply its own preview URL.
    mockDetect()

    const result = await analyzeImage(new File([''], 'loon.jpg'))

    expect(result.saved).toBe(false)
    expect(result.imageUrl).toBe('')
  })

  it('treats "no loons found" as a result, not a failure', async () => {
    mockDetect(detectionResult({ detections: [] }))
    await expect(analyzeImage(new File([''], 'empty.jpg'))).resolves.toMatchObject({
      detections: [],
    })
  })

  it('propagates a typed error the UI can branch on', async () => {
    mockIPC(() => rejectWith({ code: 'DECODE_FAILED', message: 'Not readable.', status: 422 }))

    await expect(analyzeImage(new File([''], 'bad.jpg'))).rejects.toMatchObject({
      code: 'DECODE_FAILED',
      message: 'Not readable.',
      status: 422,
    })
  })
})
