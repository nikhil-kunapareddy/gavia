export interface BoundingBox {
  /** Percentages of the image, 0-100, so the overlay is resolution-independent. */
  x: number
  y: number
  width: number
  height: number
}

export interface Detection {
  id: string
  label: string
  confidence: number
  boundingBox: BoundingBox
}

export interface DetectionResult {
  id: string
  /**
   * Where to load the image from. Empty for a result that has not been saved
   * yet — nothing is on the server until the reviewer keeps it, so the check
   * page shows its own object URL in the meantime.
   */
  imageUrl: string
  /** Small preview for the history grid; empty until saved, like `imageUrl`. */
  thumbnailUrl: string
  fileName: string
  fileSize: number
  detections: Detection[]
  /** Seconds of inference, as measured by the backend. */
  processingTime: number
  timestamp: string

  imageWidth: number
  imageHeight: number
  modelName: string
  /** 1 for a normal whole-image pass; higher when tiled inference was used. */
  tilesProcessed: number
  saved: boolean
}
