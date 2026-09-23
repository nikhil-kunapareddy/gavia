import { ImagePlus, Upload, X } from 'lucide-react'
import { useRef, useState } from 'react'

interface ImageUploaderProps {
  file: File | null
  previewUrl: string | null
  onFile: (file: File) => void
  onRemove: () => void
}

const accepted = 'image/jpeg,image/png,image/webp'

export function ImageUploader({ file, previewUrl, onFile, onRemove }: ImageUploaderProps) {
  const uploadRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)
  const [error, setError] = useState('')

  function acceptFile(nextFile?: File) {
    if (!nextFile) return
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(nextFile.type)) {
      setError("This image format isn't supported. Please upload a JPG, PNG, or WEBP image.")
      return
    }
    if (nextFile.size > 20 * 1024 * 1024) {
      setError('This image is too large. Please choose an image smaller than 20 MB.')
      return
    }
    setError('')
    onFile(nextFile)
  }

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
        <input
          ref={uploadRef}
          className="sr-only"
          type="file"
          accept={accepted}
          onChange={(event) => acceptFile(event.target.files?.[0])}
        />
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
          acceptFile(event.dataTransfer.files[0])
        }}
      >
        <div className="upload-mark">
          <ImagePlus size={25} strokeWidth={1.7} />
        </div>
        <p className="drop-title">Drop an image here</p>
        <p className="muted">or choose a photo from your device</p>
        <button className="button button-dark" onClick={() => uploadRef.current?.click()}>
          <Upload size={17} /> Upload a photo
        </button>
        <p className="format-note">JPG, PNG, or WEBP · up to 20 MB</p>
        <input
          ref={uploadRef}
          className="sr-only"
          type="file"
          accept={accepted}
          onChange={(event) => acceptFile(event.target.files?.[0])}
        />
      </div>
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}
