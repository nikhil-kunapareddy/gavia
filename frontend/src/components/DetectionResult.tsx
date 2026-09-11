import { Check, Download, FileText, RotateCcw, Save, ThumbsDown, ThumbsUp } from 'lucide-react'
import { useState } from 'react'
import { highestConfidence, pluralizeLoons, toPercent } from '../lib/format'
import type { DetectionResult as Result } from '../types/detection'
import { DetectionOverlay } from './DetectionOverlay'

interface DetectionResultProps {
  result: Result
  onCheckAnother: () => void
  onSave: () => void
  saved: boolean
  saving?: boolean
  /**
   * Whether this result still has its source file to hand. A result reopened
   * from history does not, and is already saved anyway.
   */
  savable?: boolean
}

const BOX_COLOR = '#ef6a4a'

/**
 * Draws the detection boxes onto a copy of the image and triggers a download.
 *
 * Resolves to false when the image cannot be loaded or the canvas is tainted
 * by cross-origin content, so the caller can surface a message.
 */
function downloadAnnotated(result: Result): Promise<boolean> {
  return new Promise((resolve) => {
    const image = new Image()
    image.crossOrigin = 'anonymous'

    image.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = image.naturalWidth
      canvas.height = image.naturalHeight

      const context = canvas.getContext('2d')
      if (!context) {
        resolve(false)
        return
      }

      context.drawImage(image, 0, 0)

      result.detections.forEach((detection, index) => {
        const { x, y, width, height } = detection.boundingBox
        const boxX = (x / 100) * canvas.width
        const boxY = (y / 100) * canvas.height

        context.strokeStyle = BOX_COLOR
        context.lineWidth = Math.max(4, canvas.width / 180)
        context.strokeRect(boxX, boxY, (width / 100) * canvas.width, (height / 100) * canvas.height)

        context.fillStyle = BOX_COLOR
        context.font = `bold ${Math.max(20, canvas.width / 42)}px sans-serif`
        context.fillText(
          `${index + 1} · ${toPercent(detection.confidence)}%`,
          boxX,
          Math.max(24, boxY - 10),
        )
      })

      try {
        const link = document.createElement('a')
        link.download = `loon-check-${result.fileName}`
        link.href = canvas.toDataURL('image/jpeg', 0.92)
        link.click()
        resolve(true)
      } catch (cause) {
        console.error('Could not export the annotated image:', cause)
        resolve(false)
      }
    }

    image.onerror = () => resolve(false)

    // Assigned last: setting src before the handlers can miss the load event
    // for images that resolve synchronously from cache.
    image.src = result.imageUrl
  })
}

export function DetectionResult({
  result,
  onCheckAnother,
  onSave,
  saved,
  saving = false,
  savable = true,
}: DetectionResultProps) {
  const [feedback, setFeedback] = useState<'yes' | 'no' | null>(null)
  const [downloadError, setDownloadError] = useState('')

  const found = result.detections.length > 0
  const highest = highestConfidence(result.detections)

  async function handleDownload() {
    setDownloadError('')
    const ok = await downloadAnnotated(result)
    if (!ok) setDownloadError('Could not prepare the image for download. Please try again.')
  }

  return (
    <div className="result-layout">
      <section className={`result-banner ${found ? 'result-found' : 'result-clear'}`}>
        <div className="result-icon">{found ? <Check size={22} /> : <FileText size={22} />}</div>
        <div>
          <p className="eyebrow">Check complete</p>
          <h1>
            {found ? `${pluralizeLoons(result.detections.length)} detected` : 'No loon detected'}
          </h1>
          <p>
            {found
              ? `We found ${result.detections.length === 1 ? 'a loon' : pluralizeLoons(result.detections.length)} in this image.`
              : "We didn't find a loon in this image."}
          </p>
        </div>
      </section>

      <section className="result-main-grid">
        <div className="result-image-column">
          <DetectionOverlay
            imageUrl={result.imageUrl}
            detections={result.detections}
            alt={`Analyzed image: ${result.fileName}`}
          />
          <p className="image-caption">
            {found
              ? 'Highlighted areas show where a loon was found.'
              : 'Review the image carefully when accuracy is important.'}
          </p>
        </div>

        <div className="details-column">
          {found ? (
            <>
              <div className="detail-heading">
                <span className="status-dot" /> Detection details
              </div>
              <div className="confidence-card">
                <div className="confidence-top">
                  <span>Highest confidence</span>
                  <strong>{toPercent(highest)}%</strong>
                </div>
                <div className="confidence-track">
                  <span style={{ width: `${highest * 100}%` }} />
                </div>
                <p>Confidence indicates how strongly the model matched this image to a loon.</p>
              </div>
              <div className="detection-list">
                {result.detections.map((detection, index) => (
                  <div className="detection-row" key={detection.id}>
                    <span>
                      <b>{index + 1}</b> Loon
                    </span>
                    <strong>{toPercent(detection.confidence)}%</strong>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <div className="clear-note">
              <p>This result is generated by an AI model and may not always be correct.</p>
              <button className="button button-dark" onClick={onCheckAnother}>
                <RotateCcw size={17} /> Try another image
              </button>
            </div>
          )}

          <details className="details-disclosure">
            <summary>View details</summary>
            <dl>
              <div>
                <dt>File name</dt>
                <dd>{result.fileName}</dd>
              </div>
              <div>
                <dt>Date analyzed</dt>
                <dd>{new Date(result.timestamp).toLocaleString()}</dd>
              </div>
              <div>
                <dt>Processing time</dt>
                <dd>{result.processingTime.toFixed(1)} seconds</dd>
              </div>
            </dl>
          </details>
        </div>
      </section>

      <section className="result-actions">
        <button className="button button-dark" onClick={onCheckAnother}>
          <RotateCcw size={17} /> Check another image
        </button>
        <button
          className="button button-outline"
          onClick={onSave}
          disabled={saved || saving || !savable}
        >
          <Save size={17} /> {saved ? 'Saved to history' : saving ? 'Saving…' : 'Save result'}
        </button>
        <button className="button button-quiet" onClick={() => void handleDownload()}>
          <Download size={17} /> Download image
        </button>
      </section>

      {downloadError && (
        <p className="error-text" role="alert">
          {downloadError}
        </p>
      )}

      <section className="feedback-row">
        <span>Was this result helpful?</span>
        <button
          className={`feedback-button ${feedback === 'yes' ? 'selected' : ''}`}
          onClick={() => setFeedback('yes')}
          aria-pressed={feedback === 'yes'}
        >
          <ThumbsUp size={15} /> Yes
        </button>
        <button
          className={`feedback-button ${feedback === 'no' ? 'selected' : ''}`}
          onClick={() => setFeedback('no')}
          aria-pressed={feedback === 'no'}
        >
          <ThumbsDown size={15} /> No
        </button>
      </section>
    </div>
  )
}
