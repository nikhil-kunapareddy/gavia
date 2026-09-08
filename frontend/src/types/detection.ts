export interface BoundingBox {
  x: number
  y: number
  width: number
  height: number
}

export interface Detection {
  id: string
  label: 'Loon'
  confidence: number
  boundingBox: BoundingBox
}

export interface DetectionResult {
  id: string
  imageUrl: string
  fileName: string
  fileSize: number
  detections: Detection[]
  processingTime: number
  timestamp: string
  isSample?: boolean
}
