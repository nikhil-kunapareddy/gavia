import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { analyzeImage } from './detectionService'

const fetchMock = vi.fn()

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function detectionResponse(overrides = {}) {
  return new Response(
    JSON.stringify({
      id: 'abc',
      imageUrl: '',
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
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )
}

describe('analyzeImage', () => {
  it('posts the file as multipart form data', async () => {
    fetchMock.mockResolvedValue(detectionResponse())
    const file = new File(['bytes'], 'loon.jpg', { type: 'image/jpeg' })

    await analyzeImage(file)

    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(path).toBe('/api/detect')
    expect(init.method).toBe('POST')
    expect((init.body as FormData).get('image')).toBe(file)
  })

  it('returns the detections in the shape the overlay draws', async () => {
    fetchMock.mockResolvedValue(detectionResponse())

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
    // Detection is a preview; nothing exists server-side until the reviewer
    // keeps it, so the caller has to supply its own preview URL.
    fetchMock.mockResolvedValue(detectionResponse())

    const result = await analyzeImage(new File([''], 'loon.jpg'))

    expect(result.saved).toBe(false)
    expect(result.imageUrl).toBe('')
  })

  it('treats "no loons found" as a result, not a failure', async () => {
    fetchMock.mockResolvedValue(detectionResponse({ detections: [] }))
    await expect(analyzeImage(new File([''], 'empty.jpg'))).resolves.toMatchObject({
      detections: [],
    })
  })

  it('propagates a typed error the UI can branch on', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ error: { code: 'DECODE_FAILED', message: 'Not readable.' } }),
        { status: 422, headers: { 'content-type': 'application/json' } },
      ),
    )

    await expect(analyzeImage(new File([''], 'bad.jpg'))).rejects.toMatchObject({
      code: 'DECODE_FAILED',
    })
  })
})
