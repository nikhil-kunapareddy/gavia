import { ChevronRight, LoaderCircle, RotateCcw, Save, Square } from 'lucide-react'
import { capitalize, countOf, highestConfidence, toPercent } from '../lib/format'
import type { BatchBusy, BatchItem } from '../types/batch'
import type { Subject } from '../types/detection'

interface BatchPageProps {
  items: BatchItem[]
  /** What the chosen model looks for; checked images say what theirs found. */
  subject: Subject
  busy: BatchBusy
  /** What was left out when the images were chosen, if anything. */
  notice: string
  error: string
  onCheck: () => void
  onStop: () => void
  onSaveAll: () => void
  onStartOver: () => void
  onOpen: (key: string) => void
}

function foundCount(item: BatchItem): number {
  return item.result?.detections.length ?? 0
}

function statusText(item: BatchItem, subject: Subject): string {
  switch (item.status) {
    case 'waiting':
      return 'Waiting'
    case 'checking':
      return 'Checking…'
    case 'failed':
      return item.error ?? 'Could not be checked'
    case 'done': {
      const detections = item.result?.detections ?? []
      const looked = item.result?.subject ?? subject
      const summary = detections.length
        ? `${countOf(detections.length, looked)} · ${toPercent(highestConfidence(detections))}%`
        : `No ${looked.one} detected`
      return item.result?.saved ? `${summary} · Saved` : summary
    }
  }
}

function statusClass(item: BatchItem): string {
  if (item.status === 'failed') return 'batch-status failed'
  return foundCount(item) > 0 ? 'batch-status found' : 'batch-status'
}

function images(count: number): string {
  return `${count} ${count === 1 ? 'image' : 'images'}`
}

export function BatchPage({
  items,
  subject: chosen,
  busy,
  notice,
  error,
  onCheck,
  onStop,
  onSaveAll,
  onStartOver,
  onOpen,
}: BatchPageProps) {
  const total = items.length
  const checked = items.filter((item) => item.status === 'done' || item.status === 'failed').length
  const pending = items.filter((item) => item.status !== 'done').length
  const withFinds = items.filter((item) => foundCount(item) > 0)
  const unsaved = withFinds.filter((item) => !item.result?.saved).length
  // The batch's own results say what was looked for, even if the model has
  // been changed in Settings since.
  const subject = items.find((item) => item.result)?.result?.subject ?? chosen
  const running = busy === 'checking' || busy === 'stopping'

  const heading = running
    ? `Checking ${Math.min(checked + 1, total)} of ${total}`
    : checked === 0
      ? `${images(total)} to check`
      : `${capitalize(subject.many)} in ${withFinds.length} of ${images(checked)}`

  return (
    <section className="batch-page">
      <div className="section-heading">
        <div>
          <h1>{heading}</h1>
          <p className="intro-lede">
            {checked === 0 && !running
              ? 'Each image is checked on this computer, one at a time.'
              : `Open a checked image to see where the ${subject.many} are.`}
          </p>
        </div>
      </div>

      {(running || checked > 0) && (
        <div
          className="batch-progress"
          role="progressbar"
          aria-label="Images checked"
          aria-valuemin={0}
          aria-valuemax={total}
          aria-valuenow={checked}
        >
          <span style={{ width: `${(checked / total) * 100}%` }} />
        </div>
      )}

      <div className="batch-actions">
        {running ? (
          <button className="button button-outline" onClick={onStop} disabled={busy === 'stopping'}>
            {busy === 'stopping' ? (
              <>
                <LoaderCircle className="spin" size={17} /> Stopping…
              </>
            ) : (
              <>
                <Square size={15} /> Stop
              </>
            )}
          </button>
        ) : (
          pending > 0 && (
            <button className="button button-accent" onClick={onCheck} disabled={busy !== null}>
              {checked === 0 ? `Check ${images(total)}` : `Check the remaining ${pending}`}
              <ChevronRight size={18} />
            </button>
          )
        )}
        {withFinds.length > 0 && (
          <button
            className="button button-outline"
            onClick={onSaveAll}
            disabled={busy !== null || unsaved === 0}
          >
            <Save size={17} />
            {busy === 'saving'
              ? 'Saving…'
              : unsaved === 0
                ? 'Saved to history'
                : `Save ${unsaved} with ${subject.many}`}
          </button>
        )}
        <button className="button button-quiet" onClick={onStartOver} disabled={busy !== null}>
          <RotateCcw size={17} /> Start over
        </button>
      </div>

      {notice && <p className="notice-text">{notice}</p>}
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}

      <ul className="batch-grid">
        {items.map((item) => (
          <li key={item.key}>
            <button
              className="batch-card"
              onClick={() => onOpen(item.key)}
              disabled={item.status !== 'done'}
            >
              <img src={item.previewUrl} alt="" loading="lazy" decoding="async" />
              <span className="batch-card-content">
                <strong>{item.file.name}</strong>
                <span className={statusClass(item)}>{statusText(item, subject)}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}
