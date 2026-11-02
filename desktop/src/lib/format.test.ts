import { describe, expect, it } from 'vitest'
import type { Detection } from '../types/detection'
import {
  LOONS,
  article,
  capitalize,
  countOf,
  formatFileSize,
  highestConfidence,
  toPercent,
  withArticle,
} from './format'

function detection(id: string, confidence: number): Detection {
  return { id, label: 'Loon', confidence, boundingBox: { x: 0, y: 0, width: 10, height: 10 } }
}

describe('highestConfidence', () => {
  it('returns 0 for no detections', () => {
    expect(highestConfidence([])).toBe(0)
  })

  it('returns the single confidence when there is one detection', () => {
    expect(highestConfidence([detection('a', 0.94)])).toBe(0.94)
  })

  // The original code read detections[0], which is only correct when the list
  // happens to be sorted descending.
  it('finds the maximum when detections are not sorted descending', () => {
    const unsorted = [detection('a', 0.62), detection('b', 0.97), detection('c', 0.81)]
    expect(highestConfidence(unsorted)).toBe(0.97)
  })

  it('is unaffected by ordering', () => {
    const values = [detection('a', 0.5), detection('b', 0.9)]
    expect(highestConfidence(values)).toBe(highestConfidence([...values].reverse()))
  })
})

describe('toPercent', () => {
  it.each([
    [0, 0],
    [0.94, 94],
    [0.937, 94],
    [0.935, 94],
    [1, 100],
  ])('converts %s to %i', (input, expected) => {
    expect(toPercent(input)).toBe(expected)
  })
})

describe('countOf', () => {
  const plants = { one: 'invasive plant', many: 'invasive plants' }

  it('uses the singular for exactly one', () => {
    expect(countOf(1, LOONS)).toBe('1 loon')
    expect(countOf(1, plants)).toBe('1 invasive plant')
  })

  it.each([0, 2, 5])('uses the plural for %i', (count) => {
    expect(countOf(count, LOONS)).toBe(`${count} loons`)
    expect(countOf(count, plants)).toBe(`${count} invasive plants`)
  })
})

describe('articles and capitals', () => {
  it('says "an" before a vowel and "a" otherwise', () => {
    expect(article('invasive plant')).toBe('an')
    expect(withArticle('loon')).toBe('a loon')
    expect(withArticle('invasive plant')).toBe('an invasive plant')
  })

  it('capitalizes only the first letter', () => {
    expect(capitalize('invasive plants')).toBe('Invasive plants')
    expect(capitalize('')).toBe('')
  })
})

describe('formatFileSize', () => {
  it('renders megabytes to two decimals', () => {
    expect(formatFileSize(1_840_000)).toBe('1.75 MB')
  })
})
