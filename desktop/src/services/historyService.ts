import type { DetectionResult } from '../types/detection'
import { call, frame } from './api'

/**
 * Saved checks, newest first, from the core's SQLite history.
 *
 * History used to live in `localStorage`, inlining each image as a base64 data
 * URL and shedding the oldest checks whenever the ~5MB quota filled up —
 * silent data loss in a tool meant to keep a record.
 */
export async function loadHistory(): Promise<DetectionResult[]> {
  return call<DetectionResult[]>('list_results')
}

/**
 * Commit a result to the history.
 *
 * The image is re-sent because `analyzeImage` deliberately keeps nothing
 * core-side, so an abandoned review leaves no trace on disk.
 */
export async function saveResult(result: DetectionResult, file: File): Promise<DetectionResult> {
  const body = await frame(
    {
      id: result.id,
      fileName: result.fileName,
      detections: result.detections,
      processingTime: result.processingTime,
      imageWidth: result.imageWidth,
      imageHeight: result.imageHeight,
      modelName: result.modelName,
      tilesProcessed: result.tilesProcessed,
    },
    file,
  )
  return call<DetectionResult>('save_result', body)
}

export async function deleteResult(id: string): Promise<void> {
  await call<{ deleted: number }>('delete_result', { id })
}

export async function clearHistory(): Promise<number> {
  const { deleted } = await call<{ deleted: number }>('clear_results')
  return deleted
}
