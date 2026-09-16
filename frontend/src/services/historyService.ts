import type { DetectionResult } from '../types/detection'
import { request } from './api'

/**
 * Saved checks, newest first.
 *
 * History lives in the backend's SQLite database now rather than in
 * `localStorage`. The old version inlined each image as a base64 data URL and
 * shed the user's oldest saved checks whenever the ~5MB quota filled up —
 * silent data loss in a tool meant to keep a record.
 */
export async function loadHistory(): Promise<DetectionResult[]> {
  return request<DetectionResult[]>('/api/results')
}

/**
 * Commit a result to the history.
 *
 * The image is re-sent because `analyzeImage` deliberately keeps nothing
 * server-side. Over loopback that copy is cheap, and it means an abandoned
 * review leaves no trace on disk.
 */
export async function saveResult(result: DetectionResult, file: File): Promise<DetectionResult> {
  const body = new FormData()
  body.append('image', file)
  body.append(
    'result',
    JSON.stringify({
      id: result.id,
      fileName: result.fileName,
      detections: result.detections,
      processingTime: result.processingTime,
      imageWidth: result.imageWidth,
      imageHeight: result.imageHeight,
      modelName: result.modelName,
      tilesProcessed: result.tilesProcessed,
    }),
  )

  return request<DetectionResult>('/api/results', { method: 'POST', body })
}

export async function deleteResult(id: string): Promise<void> {
  await request<{ deleted: number }>(`/api/results/${id}`, { method: 'DELETE' })
}

export async function clearHistory(): Promise<number> {
  const { deleted } = await request<{ deleted: number }>('/api/results', { method: 'DELETE' })
  return deleted
}

/** Small preview for the history grid; falls back to the original server-side. */
export function thumbnailUrl(id: string): string {
  return `/api/results/${id}/thumb`
}
