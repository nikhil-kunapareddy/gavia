import { clearMocks, mockIPC } from '@tauri-apps/api/mocks'
import { afterEach, describe, expect, it } from 'vitest'
import type { DetectionResult } from '../types/detection'
import { ApiError, unframe } from './api'
import { clearHistory, deleteResult, loadHistory, saveResult } from './historyService'

/** Reject the way the core does: with a plain object, not an Error. */
function rejectWith(value: unknown): never {
  throw value
}

function makeResult(id: string, overrides: Partial<DetectionResult> = {}): DetectionResult {
  return {
    id,
    imageUrl: '',
    thumbnailUrl: '',
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

interface Call {
  cmd: string
  payload: unknown
}

/** Answer every command with `response`, recording what each was sent. */
function mockCore(response: unknown): Call[] {
  const calls: Call[] = []
  mockIPC((cmd, payload) => {
    calls.push({ cmd, payload })
    return response
  })
  return calls
}

afterEach(() => {
  clearMocks()
  delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
})

describe('loadHistory', () => {
  it('returns what the core returns', async () => {
    const calls = mockCore([makeResult('a'), makeResult('b')])

    const history = await loadHistory()

    expect(history.map((entry) => entry.id)).toEqual(['a', 'b'])
    expect(calls.map((c) => c.cmd)).toEqual(['list_results'])
  })

  it('returns an empty list rather than inventing placeholder entries', async () => {
    mockCore([])
    await expect(loadHistory()).resolves.toEqual([])
  })
})

describe('saveResult', () => {
  it('sends the image alongside the reviewed detections', async () => {
    const stored = makeResult('abc', {
      saved: true,
      imageUrl: 'gavia://localhost/results/abc/image',
      thumbnailUrl: 'gavia://localhost/results/abc/thumb',
    })
    const calls = mockCore(stored)

    const file = new File(['bytes'], 'loon.jpg', { type: 'image/jpeg' })
    const detections = [
      {
        id: 'abc-0',
        label: 'Loon',
        confidence: 0.9,
        boundingBox: { x: 1, y: 2, width: 3, height: 4 },
      },
    ]
    const result = await saveResult(makeResult('abc', { detections }), file)

    expect(result).toEqual(stored)
    expect(calls).toHaveLength(1)
    expect(calls[0].cmd).toBe('save_result')

    // The detections the reviewer actually looked at have to be what is
    // stored, so they travel with the request rather than being recomputed.
    const { meta, bytes } = unframe(calls[0].payload as Uint8Array)
    expect(meta).toEqual({
      id: 'abc',
      fileName: 'abc.jpg',
      detections,
      processingTime: 1,
      imageWidth: 4000,
      imageHeight: 3000,
      modelName: 'loon_v1',
      tilesProcessed: 1,
    })
    expect(new TextDecoder().decode(bytes)).toBe('bytes')
  })

  it('surfaces a typed error the UI can branch on', async () => {
    mockIPC(() => rejectWith({ code: 'ALREADY_SAVED', message: 'Already there.', status: 409 }))

    await expect(saveResult(makeResult('dup'), new File([''], 'x.jpg'))).rejects.toMatchObject({
      code: 'ALREADY_SAVED',
      status: 409,
    })
  })
})

describe('deleteResult and clearHistory', () => {
  it('deletes one result by id', async () => {
    const calls = mockCore({ deleted: 1 })
    await deleteResult('abc')
    expect(calls).toEqual([{ cmd: 'delete_result', payload: { id: 'abc' } }])
  })

  it('reports how many results were cleared', async () => {
    const calls = mockCore({ deleted: 7 })
    await expect(clearHistory()).resolves.toBe(7)
    expect(calls.map((c) => c.cmd)).toEqual(['clear_results'])
  })
})

describe('error translation', () => {
  it('turns a failure that never reached a command into INTERNAL_ERROR', async () => {
    mockIPC(() => rejectWith(new Error('command list_results not found')))

    await expect(loadHistory()).rejects.toBeInstanceOf(ApiError)
    await expect(loadHistory()).rejects.toMatchObject({ code: 'INTERNAL_ERROR', status: 0 })
  })

  it('propagates a core error from delete and clear', async () => {
    mockIPC(() => rejectWith({ code: 'NOT_FOUND', message: 'No such result.', status: 404 }))

    await expect(deleteResult('gone')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(clearHistory()).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})
