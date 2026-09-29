import { ImagePlus, Upload, X } from 'lucide-react'
import { useRef, useState } from 'react'
import { IMAGE_TYPES, MAX_BATCH_IMAGES, isZip, selectImages, type Skipped } from '../lib/batch'

interface ImageUploaderProps {
  file: File | null
  previewUrl: string | null
  /** Between 1 and `MAX_BATCH_IMAGES` images, zips already unpacked. */
  onFiles: (images: File[], skipped: Skipped[]) => void
  onRemove: () => void
}

const accepted = [...IMAGE_TYPES, 'application/zip', '.zip'].join(',')

export function ImageUploader({ file, previewUrl, onFiles, onRemove }: ImageUploaderProps) {
  const uploadRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)
  const [opening, setOpening] = useState(false)
  const [error, setError] = useState('')

  async function acceptFiles(list: ArrayLike<File> | null) {
    const files = Array.from(list ?? [])
    if (files.length === 0) return
    // Only a zip takes long enough to be worth saying so.
    setOpening(files.some(isZip))
    try {
      const selection = await selectImages(files)
      if (!selection.ok) {
        setError(selection.message)
        return
      }
      setError('')
      onFiles(selection.images, selection.skipped)
    } finally {
      setOpening(false)
    }
  }

  const input = (
    <input
      ref={uploadRef}
      className="sr-only"
      type="file"
      accept={accepted}
      multiple
      onChange={(event) => void acceptFiles(event.target.files)}
    />
  )

  if (file && previewUrl) {
    return (
      <div className="preview-card">
        <div className="preview-image-wrap">
          <img src={previewUrl} alt={`Preview of ${file.name}`} />
          <button
            className="icon-button preview-remove"
            onClick={onRemove}
            aria-label="Remove selected image"
            title="Remove image"
          >
            <X size={18} />
          </button>
        </div>
        <div className="preview-meta">
          <div>
            <p className="file-name">{file.name}</p>
            <p className="muted">{(file.size / 1024 / 1024).toFixed(2)} MB</p>
          </div>
          <button className="text-button" onClick={() => uploadRef.current?.click()}>
            Change image
          </button>
        </div>
        {input}
      </div>
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
          void acceptFiles(event.dataTransfer.files)
        }}
      >
        <div className="upload-mark">
          <ImagePlus size={25} strokeWidth={1.7} />
        </div>
        <p className="drop-title">Drop images or a zip here</p>
        <p className="muted">or choose photos from your device</p>
        <button
          className="button button-dark"
          onClick={() => uploadRef.current?.click()}
          disabled={opening}
        >
          <Upload size={17} /> Upload photos
        </button>
        <p className="format-note">
          JPG, PNG, WEBP, or a ZIP of them · up to {MAX_BATCH_IMAGES} images, 20 MB each
        </p>
        {input}
      </div>
      {opening && (
        <p className="notice-text" role="status">
          Opening the zip…
        </p>
      )}
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}
