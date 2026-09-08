import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DetectionResult } from '../types/detection'
import { clearHistory, loadHistory, saveHistory } from './historyService'

const STORAGE_KEY = 'loon-detector-history'

function makeResult(id: string, overrides: Partial<DetectionResult> = {}): DetectionResult {
  return {
    id,
    imageUrl: `data:image/png;base64,${id}`,
    fileName: `${id}.jpg`,
    fileSize: 1000,
    detections: [],
    processingTime: 1,
    timestamp: '2026-09-06T10:00:00.000Z',
    ...overrides,
  }
}

/**
 * Makes every setItem throw the quota error the browser raises when full.
 *
 * Spies on the instance rather than Storage.prototype so this works under both
 * jsdom's Storage and the in-memory shim from the test setup.
 */
function failWithQuota() {
  return vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
    throw new DOMException('Quota exceeded', 'QuotaExceededError')
  })
}

beforeEach(() => {
  localStorage.clear()
})

describe('loadHistory', () => {
  it('returns the demo samples when storage is empty', () => {
    const history = loadHistory()
    expect(history).toHaveLength(3)
    expect(history.every((entry) => entry.isSample)).toBe(true)
  })

  it('recovers from malformed JSON instead of throwing', () => {
    localStorage.setItem(STORAGE_KEY, '{not json')
    expect(() => loadHistory()).not.toThrow()
    expect(loadHistory()).toHaveLength(3)
  })

  it('recovers when stored JSON is not an array', () => {
    localStorage.setItem(STORAGE_KEY, '{"unexpected":true}')
    expect(loadHistory().every((entry) => entry.isSample)).toBe(true)
  })

  it('keeps saved entries ahead of the samples', () => {
    saveHistory(makeResult('user-1'))
    const history = loadHistory()
    expect(history[0].id).toBe('user-1')
    expect(history).toHaveLength(4)
  })
})

describe('saveHistory', () => {
  it('persists a result across loads', () => {
    saveHistory(makeResult('user-1'))
    expect(loadHistory().map((entry) => entry.id)).toContain('user-1')
  })

  it('replaces an entry with the same id rather than duplicating it', () => {
    saveHistory(makeResult('user-1'))
    saveHistory(makeResult('user-1', { fileName: 'renamed.jpg' }))
    const matches = loadHistory().filter((entry) => entry.id === 'user-1')
    expect(matches).toHaveLength(1)
    expect(matches[0].fileName).toBe('renamed.jpg')
  })

  it('caps saved entries at 20 without evicting the demo samples', () => {
    for (let index = 0; index < 25; index += 1) saveHistory(makeResult(`user-${index}`))

    const history = loadHistory()
    expect(history.filter((entry) => !entry.isSample)).toHaveLength(20)
    expect(history.filter((entry) => entry.isSample)).toHaveLength(3)
  })

  it('keeps the most recent entries when trimming', () => {
    for (let index = 0; index < 25; index += 1) saveHistory(makeResult(`user-${index}`))

    const ids = loadHistory().map((entry) => entry.id)
    expect(ids).toContain('user-24')
    expect(ids).not.toContain('user-0')
  })

  // Saved results embed the image as base64, so the quota is reachable in
  // ordinary use. The original implementation let this throw uncaught.
  it('does not throw when storage quota is exceeded', () => {
    failWithQuota()
    expect(() => saveHistory(makeResult('user-1'))).not.toThrow()
  })

  it('reports what was actually persisted when the quota is hit', () => {
    failWithQuota()
    const persisted = saveHistory(makeResult('user-1'))
    expect(Array.isArray(persisted)).toBe(true)
  })
})

describe('clearHistory', () => {
  it('removes saved entries but keeps the samples', () => {
    saveHistory(makeResult('user-1'))
    clearHistory()
    const history = loadHistory()
    expect(history.map((entry) => entry.id)).not.toContain('user-1')
    expect(history.every((entry) => entry.isSample)).toBe(true)
  })

  it('does not throw when storage is unavailable', () => {
    failWithQuota()
    expect(() => clearHistory()).not.toThrow()
  })
})
