import { AudioLines, Upload, X } from 'lucide-react'
import { useRef, useState } from 'react'
import { formatFileSize } from '../lib/format'
import {
  MAX_RECORDING_MB,
  RECORDING_ACCEPT,
  RECORDING_FORMATS,
  recordingProblem,
} from '../lib/calls'

interface AudioUploaderProps {
  file: File | null
  audioUrl: string | null
  onFile: (recording: File) => void
  onRemove: () => void
}

export function AudioUploader({ file, audioUrl, onFile, onRemove }: AudioUploaderProps) {
  const uploadRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)
  const [error, setError] = useState('')

  function acceptFiles(list: ArrayLike<File> | null) {
    const files = Array.from(list ?? [])
    if (files.length === 0) return
    if (files.length > 1) {
      setError('Choose one recording at a time.')
      return
    }
    const problem = recordingProblem(files[0])
    if (problem) {
      setError(problem)
      return
    }
    setError('')
    onFile(files[0])
  }

  const input = (
    <input
      ref={uploadRef}
      className="sr-only"
      type="file"
      accept={RECORDING_ACCEPT}
      onChange={(event) => {
        acceptFiles(event.target.files)
        // Choosing the same file again should still count as a choice.
        event.target.value = ''
      }}
    />
  )
  const errorText = error && (
    <p className="error-text" role="alert">
      {error}
    </p>
  )

  if (file && audioUrl) {
    return (
      <>
        <div className="preview-card audio-preview">
          <div className="audio-preview-top">
            <div className="upload-mark">
              <AudioLines size={22} strokeWidth={1.7} />
            </div>
            <div className="audio-preview-name">
              <p className="file-name">{file.name}</p>
              <p className="muted">{formatFileSize(file.size)}</p>
            </div>
            <button
              className="icon-button audio-remove"
              onClick={onRemove}
              aria-label="Remove selected recording"
              title="Remove recording"
            >
              <X size={18} />
            </button>
          </div>
          <audio className="audio-player" src={audioUrl} controls preload="metadata">
            Your system can&apos;t play this recording here, but it can still be checked.
          </audio>
          <div className="preview-meta">
            <p className="muted">Listen first if you like; checking doesn&apos;t need it.</p>
            <button className="text-button" onClick={() => uploadRef.current?.click()}>
              Change recording
            </button>
          </div>
          {input}
        </div>
        {errorText}
      </>
    )
  }

  return (
    <div className="uploader-stack">
      <div
        className={`drop-zone ${dragging ? 'drop-zone-active' : ''}`}
        onDragOver={(event) => {
          event.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault()
          setDragging(false)
          acceptFiles(event.dataTransfer.files)
        }}
      >
        <div className="upload-mark">
          <AudioLines size={25} strokeWidth={1.7} />
        </div>
        <p className="drop-title">Drop a recording here</p>
        <p className="muted">or choose one from your device</p>
        <button className="button button-dark" onClick={() => uploadRef.current?.click()}>
          <Upload size={17} /> Upload a recording
        </button>
        <p className="format-note">
          {RECORDING_FORMATS}, or a video&apos;s sound · up to {MAX_RECORDING_MB} MB
        </p>
        {input}
      </div>
      {errorText}
    </div>
  )
}
