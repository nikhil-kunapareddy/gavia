import { ChevronRight, LoaderCircle, ShieldCheck, Sparkles } from 'lucide-react'
import { ImageUploader } from '../components/ImageUploader'

interface CheckPageProps {
  file: File | null
  previewUrl: string | null
  processing: boolean
  error: string
  onFile: (file: File) => void
  onRemove: () => void
  onCheck: () => void
}

export function CheckPage({
  file,
  previewUrl,
  processing,
  error,
  onFile,
  onRemove,
  onCheck,
}: CheckPageProps) {
  return (
    <>
      <div className="page-intro">
        <div className="intro-copy">
          <p className="eyebrow">
            <span className="eyebrow-line" /> Field image check
          </p>
          <h1>
            Is this a <em>loon?</em>
          </h1>
          <p className="intro-lede">
            Upload a photo or take a picture to check whether a loon is present.
          </p>
        </div>
        <div className="intro-stamp">
          <ShieldCheck size={17} />
          <span>
            Built for careful
            <br />
            conservation work
          </span>
        </div>
      </div>

      <div className="check-panel">
        <ImageUploader file={file} previewUrl={previewUrl} onFile={onFile} onRemove={onRemove} />
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
                Check for loons <ChevronRight size={18} />
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
              <small>Looking for loon-like features in this photo.</small>
            </span>
          </div>
        )}
      </div>

      <div className="small-note">
        <span className="note-rule" /> AI-generated results can contain errors. Review results when
        accuracy is important.
      </div>
    </>
  )
}
