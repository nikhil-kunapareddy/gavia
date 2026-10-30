import { clearMocks, mockIPC } from '@tauri-apps/api/mocks'
import { afterEach, describe, expect, it } from 'vitest'
import { ApiError, unframe } from './api'
import { analyzeRecording } from './callService'

/** Reject the way the core does: with a plain object, not an Error. */
function rejectWith(value: unknown): never {
  throw value
}

afterEach(() => {
  clearMocks()
  delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
})

const heard = {
  id: 'abc',
  fileName: 'lake.mp3',
  fileSize: 5,
  duration: 6.6,
  sampleRate: 48000,
  channels: 1,
  windows: [{ start: 0, end: 3, confidence: 0.91 }],
  threshold: 0.5,
  label: 'Loon call',
  modelName: 'looncall 1.0',
  processingTime: 0.2,
  timestamp: '2026-10-30T10:00:00+00:00',
}

describe('analyzeRecording', () => {
  it('sends the recording as a framed binary body to detect_calls', async () => {
    const calls: { cmd: string; payload: unknown }[] = []
    mockIPC((cmd, payload) => {
      calls.push({ cmd, payload })
      return heard
    })

    const result = await analyzeRecording(new File(['audio'], 'lake.mp3', { type: 'audio/mpeg' }))

    expect(result).toEqual(heard)
    expect(calls.map((c) => c.cmd)).toEqual(['detect_calls'])
    const { meta, bytes } = unframe<{ fileName: string; contentType: string }>(
      calls[0].payload as Uint8Array,
    )
    expect(meta).toEqual({ fileName: 'lake.mp3', contentType: 'audio/mpeg' })
    expect(new TextDecoder().decode(bytes)).toBe('audio')
  })

  it('surfaces the core error code', async () => {
    mockIPC(() => rejectWith({ code: 'RECORDING_TOO_LARGE', message: 'Too long.', status: 413 }))

    const failure = analyzeRecording(new File(['x'], 'long.wav', { type: 'audio/wav' }))

    await expect(failure).rejects.toBeInstanceOf(ApiError)
    await expect(failure).rejects.toMatchObject({ code: 'RECORDING_TOO_LARGE' })
  })
})
