import type { DetectionResult } from '../types/detection'

const STORAGE_KEY = 'loon-detector-history'

/**
 * Cap on user-saved results. Demo samples are kept in addition to this, so the
 * full list can be up to MAX_SAVED_ENTRIES + SAMPLE_RESULTS.length.
 */
const MAX_SAVED_ENTRIES = 20

function sampleImage(birds: Array<{ x: number; y: number; scale: number }>, sky = '#a8c9c5') {
  const birdShapes = birds
    .map(
      ({ x, y, scale }) => `
    <g transform="translate(${x} ${y}) scale(${scale})">
      <ellipse cx="0" cy="0" rx="34" ry="16" fill="#173e42"/>
      <path d="M-28 1 C-14 28 19 29 29 4 C18 11 -8 13 -28 1Z" fill="#102f34"/>
      <path d="M28 -5 L51 -18 L35 2Z" fill="#d88c4b"/>
      <circle cx="24" cy="-7" r="3" fill="#f4eee0"/>
    </g>`,
    )
    .join('')
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 900 620">
    <defs><linearGradient id="lake" x1="0" y1="0" x2="0" y2="1"><stop stop-color="${sky}"/><stop offset="1" stop-color="#6d9f9b"/></linearGradient></defs>
    <rect width="900" height="620" fill="url(#lake)"/>
    <path d="M0 465 C160 420 240 490 410 450 S700 420 900 468 V620 H0Z" fill="#477e78" opacity=".48"/>
    <path d="M0 532 C180 490 300 550 470 515 S720 500 900 540" fill="none" stroke="#c5dfd7" stroke-width="7" opacity=".5"/>
    ${birdShapes}
  </svg>`
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`
}

const SAMPLE_RESULTS: DetectionResult[] = [
  {
    id: 'sample-one-loon',
    imageUrl: sampleImage([{ x: 425, y: 300, scale: 1.35 }]),
    fileName: 'sample-single-loon.jpg',
    fileSize: 1840000,
    detections: [
      {
        id: 'sample-loon-1',
        label: 'Loon',
        confidence: 0.94,
        boundingBox: { x: 37, y: 35, width: 25, height: 22 },
      },
    ],
    processingTime: 1.1,
    timestamp: '2026-09-06T09:40:00.000Z',
    isSample: true,
  },
  {
    id: 'sample-three-loons',
    imageUrl: sampleImage(
      [
        { x: 220, y: 220, scale: 0.8 },
        { x: 500, y: 340, scale: 1.05 },
        { x: 725, y: 190, scale: 0.7 },
      ],
      '#b2c9bb',
    ),
    fileName: 'sample-three-loons.jpg',
    fileSize: 2630000,
    detections: [
      {
        id: 'sample-loon-1',
        label: 'Loon',
        confidence: 0.96,
        boundingBox: { x: 17, y: 27, width: 17, height: 15 },
      },
      {
        id: 'sample-loon-2',
        label: 'Loon',
        confidence: 0.91,
        boundingBox: { x: 48, y: 47, width: 24, height: 21 },
      },
      {
        id: 'sample-loon-3',
        label: 'Loon',
        confidence: 0.87,
        boundingBox: { x: 73, y: 20, width: 13, height: 13 },
      },
    ],
    processingTime: 1.4,
    timestamp: '2026-09-06T09:32:00.000Z',
    isSample: true,
  },
  {
    id: 'sample-no-loon',
    imageUrl: sampleImage([], '#c7d4c8'),
    fileName: 'sample-clear-water.jpg',
    fileSize: 1290000,
    detections: [],
    processingTime: 0.9,
    timestamp: '2026-09-06T09:25:00.000Z',
    isSample: true,
  },
]

function withSamples(entries: DetectionResult[]) {
  const presentIds = new Set(entries.map((entry) => entry.id))
  return [...entries, ...SAMPLE_RESULTS.filter((sample) => !presentIds.has(sample.id))]
}

function isQuotaError(error: unknown): boolean {
  return (
    error instanceof DOMException &&
    (error.name === 'QuotaExceededError' ||
      error.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
      error.code === 22)
  )
}

/**
 * Writes entries to localStorage, shedding the oldest saved results when the
 * quota is hit.
 *
 * Saved results embed the full image as a base64 data URL, so a couple of
 * large uploads can exhaust the ~5 MB quota. Rather than throwing and losing
 * the write entirely, drop the oldest user entries until it fits. Samples are
 * kept last because they are tiny and act as the empty-state content.
 *
 * Returns what was actually persisted, which may be shorter than the input.
 */
function persist(entries: DetectionResult[]): DetectionResult[] {
  const candidate = [...entries]

  while (candidate.length > 0) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(candidate))
      return candidate
    } catch (error) {
      if (!isQuotaError(error)) return entries

      const oldestUserEntry = candidate.map((entry) => entry.isSample === true).lastIndexOf(false)
      if (oldestUserEntry === -1) break
      candidate.splice(oldestUserEntry, 1)
    }
  }

  // Even the samples alone did not fit; leave whatever is already stored.
  return entries
}

export function loadHistory(): DetectionResult[] {
  let stored: DetectionResult[] = []

  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    const parsed: unknown = JSON.parse(raw ?? '[]')
    stored = Array.isArray(parsed) ? (parsed as DetectionResult[]) : []
  } catch {
    return [...SAMPLE_RESULTS]
  }

  const history = withSamples(stored)
  if (history.length !== stored.length) persist(history)
  return history
}

export function saveHistory(result: DetectionResult): DetectionResult[] {
  const others = loadHistory().filter((item) => item.id !== result.id)

  // Trim only user entries. Slicing the combined list would evict the demo
  // samples once 20 results had been saved.
  const saved = [result, ...others.filter((item) => !item.isSample)].slice(0, MAX_SAVED_ENTRIES)
  const samples = others.filter((item) => item.isSample)

  return persist([...saved, ...samples])
}

export function clearHistory(): void {
  persist([...SAMPLE_RESULTS])
}
