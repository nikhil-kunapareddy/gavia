/**
 * A stand-in for the Rust core, so `npm run dev` works in a plain browser.
 *
 * Screens can be designed and debugged at http://localhost:5173 without
 * building any Rust. Detections are made up, history lives in memory and is
 * gone on reload, and nothing here is ever loaded inside the app: `call` in
 * `services/api.ts` only imports this module when no Tauri core is present.
 *
 * Keep the shapes in step with `src-tauri/src/service.rs`.
 */

import { ApiError, unframe, type Args } from '../services/api'
import type { DetectionResult } from '../types/detection'

interface DetectMeta {
  fileName?: string
  contentType?: string
}

type SaveMeta = Pick<
  DetectionResult,
  | 'id'
  | 'fileName'
  | 'detections'
  | 'processingTime'
  | 'imageWidth'
  | 'imageHeight'
  | 'modelName'
  | 'tilesProcessed'
>

const ACCEPTED = new Set(['image/jpeg', 'image/png', 'image/webp'])
const saved = new Map<string, DetectionResult>()

function body(args: Args | undefined): Uint8Array {
  if (args instanceof Uint8Array) return args
  throw new ApiError('INVALID_REQUEST', 'Expected the image as a binary body.', 422)
}

function sampleDetections(id: string) {
  // Deterministic per id, so the same check looks the same on re-render.
  const seed = [...id].reduce((sum, c) => sum + c.charCodeAt(0), 0)
  const count = seed % 3
  return Array.from({ length: count }, (_, index) => ({
    id: `${id}-${index}`,
    label: 'Loon',
    confidence: 0.55 + ((seed + index * 17) % 40) / 100,
    boundingBox: { x: 12 + index * 38, y: 30 + (index % 2) * 12, width: 26, height: 22 },
  }))
}

export async function previewCall<T>(command: string, args?: Args): Promise<T> {
  // A little latency, so loading states are visible while designing them.
  await new Promise((resolve) => setTimeout(resolve, 350))

  switch (command) {
    case 'detect': {
      const { meta, bytes } = unframe<DetectMeta>(body(args))
      if (meta.contentType && !ACCEPTED.has(meta.contentType)) {
        throw new ApiError('UNSUPPORTED_FORMAT', `${meta.contentType} is not supported.`, 415)
      }
      const id = crypto.randomUUID().replace(/-/g, '')
      const result: DetectionResult = {
        id,
        imageUrl: '',
        thumbnailUrl: '',
        fileName: meta.fileName ?? 'upload',
        fileSize: bytes.length,
        detections: sampleDetections(id),
        processingTime: 0.35,
        timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, '+00:00'),
        imageWidth: 4000,
        imageHeight: 3000,
        modelName: 'loon_v1 (browser preview)',
        tilesProcessed: 1,
        saved: false,
      }
      return result as T
    }
    case 'save_result': {
      const { meta, bytes } = unframe<SaveMeta>(body(args))
      if (saved.has(meta.id)) {
        throw new ApiError('ALREADY_SAVED', 'That result is already in the history.', 409)
      }
      const url = URL.createObjectURL(new Blob([bytes.slice()]))
      const result: DetectionResult = {
        ...meta,
        imageUrl: url,
        thumbnailUrl: url,
        fileSize: bytes.length,
        timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, '+00:00'),
        saved: true,
      }
      saved.set(meta.id, result)
      return result as T
    }
    case 'list_results':
      return [...saved.values()].reverse() as T
    case 'delete_result': {
      const { id } = args as { id: string }
      if (!saved.delete(id)) throw new ApiError('NOT_FOUND', 'No saved result with that id.', 404)
      return { deleted: 1 } as T
    }
    case 'clear_results': {
      const deleted = saved.size
      saved.clear()
      return { deleted } as T
    }
    case 'health':
      return { status: 'ok', service: 'Gavia (browser preview)', version: 'dev' } as T
    default:
      throw new ApiError('INTERNAL_ERROR', `The browser preview has no "${command}" command.`, 0)
  }
}
