import type { Detection } from '../types/detection'

/** Confidence as a whole-number percentage, e.g. 0.937 -> 94. */
export function toPercent(confidence: number): number {
  return Math.round(confidence * 100)
}

/**
 * Highest confidence across all detections, or 0 when there are none.
 *
 * Detections are not guaranteed to arrive sorted, so this must scan the whole
 * list rather than read the first entry.
 */
export function highestConfidence(detections: Detection[]): number {
  return detections.reduce((max, detection) => Math.max(max, detection.confidence), 0)
}

/** "1 loon" / "3 loons" */
export function pluralizeLoons(count: number): string {
  return `${count} ${count === 1 ? 'loon' : 'loons'}`
}

export function formatDate(timestamp: string): string {
  return new Date(timestamp).toLocaleDateString(undefined, {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  })
}

/** Bytes to megabytes, two decimal places, matching the uploader's display. */
export function formatFileSize(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}
