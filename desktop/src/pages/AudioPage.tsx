import { AudioLines, ChevronRight, LoaderCircle } from 'lucide-react'
import { AudioUploader } from '../components/AudioUploader'

interface AudioPageProps {
  file: File | null
  audioUrl: string | null
  processing: boolean
  error: string
  onFile: (recording: File) => void
  onRemove: () => void
  onCheck: () => void
}

export function AudioPage({
  file,
  audioUrl,
  processing,
  error,
  onFile,
  onRemove,
  onCheck,
}: AudioPageProps) {
  return (
    <>
      <div className="page-intro">
        <div className="intro-copy">
          <h1>
            Is that a <em>loon?</em>
          </h1>
          <p className="intro-lede">
            Upload a recording to hear whether a loon is calling, and when.
          </p>
        </div>
      </div>

      <div className="check-panel">
        <AudioUploader file={file} audioUrl={audioUrl} onFile={onFile} onRemove={onRemove} />
        {file && (
          <button
            className="button button-accent check-button"
            onClick={onCheck}
            disabled={processing}
          >
            {processing ? (
              <>
                <LoaderCircle className="spin" size={18} /> Listening...
              </>
            ) : (
              <>
                Listen for loon calls <ChevronRight size={18} />
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
            <AudioLines size={17} />
            <span>
              <strong>We&apos;re listening closely.</strong>
              <small>
                Every three seconds of the recording is checked; long ones take a minute.
              </small>
            </span>
          </div>
        )}
      </div>
    </>
  )
}
