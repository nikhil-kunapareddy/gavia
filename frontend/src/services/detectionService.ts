import type { DetectionResult } from '../types/detection'
import { request } from './api'

/**
 * Run the detector over one image.
 *
 * The result is not persisted — the reviewer decides that afterwards, via
 * `saveResult`. Until then `imageUrl` is empty and the caller supplies its own
 * local preview, which it already has.
 */
export async function analyzeImage(file: File): Promise<DetectionResult> {
  const body = new FormData()
  body.append('image', file)

  return request<DetectionResult>('/api/detect', { method: 'POST', body })
}
