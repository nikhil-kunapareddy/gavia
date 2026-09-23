import type { Detection } from '../types/detection'

interface DetectionOverlayProps {
  imageUrl: string
  detections: Detection[]
  alt: string
}

export function DetectionOverlay({ imageUrl, detections, alt }: DetectionOverlayProps) {
  return (
    <div className="annotation-frame">
      <img src={imageUrl} alt={alt} />
      {detections.map((detection, index) => (
        <div
          className="detection-box"
          key={detection.id}
          style={{
            left: `${detection.boundingBox.x}%`,
            top: `${detection.boundingBox.y}%`,
            width: `${detection.boundingBox.width}%`,
            height: `${detection.boundingBox.height}%`,
          }}
        >
          <span>
            {index + 1} · {Math.round(detection.confidence * 100)}%
          </span>
        </div>
      ))}
    </div>
  )
}
