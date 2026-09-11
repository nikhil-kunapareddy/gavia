import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DetectionResult } from '../types/detection'
import { ApiError } from './api'
import {
  clearHistory,
  deleteResult,
  loadHistory,
  saveResult,
  thumbnailUrl,
} from './historyService'

function makeResult(id: string, overrides: Partial<DetectionResult> = {}): DetectionResult {
  return {
    id,
    imageUrl: '',
    fileName: `${id}.jpg`,
    fileSize: 1000,
    detections: [],
    processingTime: 1,
    timestamp: '2026-09-06T10:00:00.000Z',
    imageWidth: 4000,
    imageHeight: 3000,
    modelName: 'loon_v1',
    tilesProcessed: 1,
    saved: false,
    ...overrides,
  }
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

const fetchMock = vi.fn()

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('loadHistory', () => {
  it('returns what the API returns', async () => {
    fetchMock.mockResolvedValue(jsonResponse([makeResult('a'), makeResult('b')]))

    const history = await loadHistory()

    expect(history.map((entry) => entry.id)).toEqual(['a', 'b'])
    expect(fetchMock).toHaveBeenCalledWith('/api/results', expect.anything())
  })

  it('returns an empty list rather than inventing placeholder entries', async () => {
    fetchMock.mockResolvedValue(jsonResponse([]))
    await expect(loadHistory()).resolves.toEqual([])
  })
})

describe('saveResult', () => {
  it('sends the image alongside the reviewed detections', async () => {
    const stored = makeResult('abc', { saved: true, imageUrl: '/api/results/abc/image' })
    fetchMock.mockResolvedValue(jsonResponse(stored, 201))

    const file = new File(['bytes'], 'loon.jpg', { type: 'image/jpeg' })
    const result = await saveResult(
      makeResult('abc', {
        detections: [
          {
            id: 'abc-0',
            label: 'Loon',
            confidence: 0.9,
            boundingBox: { x: 1, y: 2, width: 3, height: 4 },
          },
        ],
      }),
      file,
    )

    expect(result.saved).toBe(true)

    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(path).toBe('/api/results')
    expect(init.method).toBe('POST')

    // The detections the reviewer actually looked at have to be what is
    // stored, so they travel with the request rather than being recomputed.
    const body = init.body as FormData
    expect(body.get('image')).toBe(file)
    const payload = JSON.parse(body.get('result') as string) as { detections: unknown[] }
    expect(payload.detections).toHaveLength(1)
  })

  it('surfaces a typed error the UI can branch on', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ error: { code: 'ALREADY_SAVED', message: 'Already there.' } }, 409),
    )

    await expect(
      saveResult(makeResult('dup'), new File([''], 'x.jpg')),
    ).rejects.toMatchObject({ code: 'ALREADY_SAVED', status: 409 })
  })
})

describe('deleteResult and clearHistory', () => {
  it('deletes one result', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ deleted: 1 }))
    await deleteResult('abc')
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/results/abc',
      expect.objectContaining({ method: 'DELETE' }),
    )
  })

  it('reports how many results were cleared', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ deleted: 7 }))
    await expect(clearHistory()).resolves.toBe(7)
  })
})

describe('error translation', () => {
  it('turns an unreachable backend into a NETWORK_ERROR', async () => {
    // The backend not being up is a different problem from a rejected image,
    // and the UI tells the user so.
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))

    await expect(loadHistory()).rejects.toBeInstanceOf(ApiError)
    await expect(loadHistory()).rejects.toMatchObject({ code: 'NETWORK_ERROR', status: 0 })
  })

  it('falls back to a status message when the body is not JSON', async () => {
    fetchMock.mockResolvedValue(new Response('<html>502</html>', { status: 502 }))
    await expect(loadHistory()).rejects.toMatchObject({ code: 'UNKNOWN', status: 502 })
  })
})

describe('thumbnailUrl', () => {
  it('points at the API thumbnail, not a base64 blob', () => {
    expect(thumbnailUrl('abc')).toBe('/api/results/abc/thumb')
  })
})
