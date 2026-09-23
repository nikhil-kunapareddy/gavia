import { ChevronRight, History } from 'lucide-react'
import { formatDate, highestConfidence, pluralizeLoons, toPercent } from '../lib/format'
import type { DetectionResult } from '../types/detection'

interface HistoryPageProps {
  history: DetectionResult[]
  loading?: boolean
  onOpenResult: (result: DetectionResult) => void
  onClearHistory: () => void
  onCheckAnother: () => void
}

function summarize(result: DetectionResult): string {
  if (result.detections.length === 0) return 'Review this result'
  const percent = toPercent(highestConfidence(result.detections))
  return `${pluralizeLoons(result.detections.length)} · ${percent}% highest confidence`
}

export function HistoryPage({
  history,
  loading = false,
  onOpenResult,
  onClearHistory,
  onCheckAnother,
}: HistoryPageProps) {
  return (
    <section className="history-page">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Your field notes</p>
          <h1>Previous checks</h1>
          <p className="intro-lede">Review images you&apos;ve checked with the loon detector.</p>
        </div>
        {history.length > 0 && (
          <button className="text-button danger-text" onClick={onClearHistory}>
            Clear history
          </button>
        )}
      </div>

      {loading ? (
        <div className="empty-history">
          <p>Loading your saved checks…</p>
        </div>
      ) : history.length === 0 ? (
        <div className="empty-history">
          <History size={29} />
          <h2>No saved checks yet</h2>
          <p>Results you save will appear here for easy review.</p>
          <button className="button button-dark" onClick={onCheckAnother}>
            Check an image
          </button>
        </div>
      ) : (
        <div className="history-grid">
          {history.map((item) => (
            <button className="history-card" key={item.id} onClick={() => onOpenResult(item)}>
              <img src={item.thumbnailUrl} alt="" loading="lazy" />
              <span className="history-card-content">
                <span
                  className={item.detections.length ? 'history-status found' : 'history-status'}
                >
                  {item.detections.length ? 'Loon detected' : 'No loon detected'}
                </span>
                <strong>{summarize(item)}</strong>
                <small>{formatDate(item.timestamp)}</small>
              </span>
              <ChevronRight size={18} />
            </button>
          ))}
        </div>
      )}
    </section>
  )
}
