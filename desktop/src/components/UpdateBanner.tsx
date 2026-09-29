import { Download, LoaderCircle } from 'lucide-react'

interface UpdateBannerProps {
  version: string
  installing: boolean
  error: string
  onInstall: () => void
  onDismiss: () => void
}

/** Offers a downloaded update. Never restarts on its own, so no work is lost. */
export function UpdateBanner({
  version,
  installing,
  error,
  onInstall,
  onDismiss,
}: UpdateBannerProps) {
  return (
    <section className="update-banner" aria-label="Update">
      <Download size={18} />
      <p>
        <strong>Gavia {version} is ready.</strong> {error || 'Restart to start using it.'}
      </p>
      <div className="update-actions">
        <button className="button button-dark" onClick={onInstall} disabled={installing}>
          {installing ? (
            <>
              <LoaderCircle className="spin" size={16} /> Installing…
            </>
          ) : (
            'Restart now'
          )}
        </button>
        <button className="button button-quiet" onClick={onDismiss} disabled={installing}>
          Later
        </button>
      </div>
    </section>
  )
}
