import { ChevronRight, LoaderCircle, Sparkles } from 'lucide-react'
import { ImageUploader } from '../components/ImageUploader'
import { ModelPicker } from '../components/ModelPicker'
import type { Skipped } from '../lib/batch'
import { article, LOONS, withArticle } from '../lib/format'
import type { Subject } from '../types/detection'
import type { AppSettings } from '../types/settings'

interface CheckPageProps {
  /** For the model menu; without settings there is no menu and checks look for loons. */
  settings?: AppSettings | null
  /** What the chosen model looks for. */
  subject?: Subject
  file: File | null
  previewUrl: string | null
  processing: boolean
  error: string
  /** What was left out of the last selection, if anything. */
  notice?: string
  onFiles: (images: File[], skipped: Skipped[]) => void
  onRemove: () => void
  onCheck: () => void
  onSelectModel?: (id: string) => void
}

export function CheckPage({
  settings = null,
  subject = LOONS,
  file,
  previewUrl,
  processing,
  error,
  notice = '',
  onFiles,
  onRemove,
  onCheck,
  onSelectModel = () => undefined,
}: CheckPageProps) {
  return (
    <>
      <div className="page-intro">
        <div className="intro-copy">
          <h1>
            Is this {article(subject.one)} <em>{subject.one}?</em>
          </h1>
          <p className="intro-lede">
            Upload photos, or a zip of them, to check whether {withArticle(subject.one)} is present.
          </p>
        </div>
      </div>

      <div className="check-panel">
        {settings && settings.models.length > 1 && (
          <ModelPicker settings={settings} disabled={processing} onSelect={onSelectModel} />
        )}
        <ImageUploader file={file} previewUrl={previewUrl} onFiles={onFiles} onRemove={onRemove} />
        {notice && <p className="notice-text">{notice}</p>}
        {file && (
          <button
            className="button button-accent check-button"
            onClick={onCheck}
            disabled={processing}
          >
            {processing ? (
              <>
                <LoaderCircle className="spin" size={18} /> Checking image...
              </>
            ) : (
              <>
                Check for {subject.many} <ChevronRight size={18} />
              </>
            )}
          </button>
        )}
        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
        {processing && (
          <div className="processing-message" role="status">
            <Sparkles size={17} />
            <span>
              <strong>We&apos;re looking closely.</strong>
              <small>Looking for {subject.many} in this photo.</small>
            </span>
          </div>
        )}
      </div>
    </>
  )
}
