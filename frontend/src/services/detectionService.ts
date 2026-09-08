import type { Detection, DetectionResult } from '../types/detection'

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export async function analyzeImage(file: File, imageUrl: string): Promise<DetectionResult> {
  await wait(1100)

  const name = file.name.toLowerCase()
  const detections: Detection[] =
    name.includes('none') || name.includes('no-loon')
      ? []
      : name.includes('three')
        ? [
            {
              id: 'loon-1',
              label: 'Loon',
              confidence: 0.96,
              boundingBox: { x: 13, y: 24, width: 20, height: 24 },
            },
            {
              id: 'loon-2',
              label: 'Loon',
              confidence: 0.91,
              boundingBox: { x: 51, y: 31, width: 18, height: 23 },
            },
            {
              id: 'loon-3',
              label: 'Loon',
              confidence: 0.87,
              boundingBox: { x: 72, y: 62, width: 16, height: 21 },
            },
          ]
        : [
            {
              id: 'loon-1',
              label: 'Loon',
              confidence: 0.94,
              boundingBox: { x: 35, y: 24, width: 29, height: 45 },
            },
          ]

  return {
    id: crypto.randomUUID(),
    imageUrl,
    fileName: file.name,
    fileSize: file.size,
    detections,
    processingTime: 1.1,
    timestamp: new Date().toISOString(),
  }
}
