import { useCallback, useEffect, useState } from 'react'
import { DetectionResult } from './components/DetectionResult'
import { SiteFooter } from './components/SiteFooter'
import { SiteHeader } from './components/SiteHeader'
import { revokeIfObjectUrl } from './lib/imageFile'
import { AboutPage } from './pages/AboutPage'
import { CheckPage } from './pages/CheckPage'
import { HistoryPage } from './pages/HistoryPage'
import { ApiError } from './services/api'
import { analyzeImage } from './services/detectionService'
import { clearHistory, loadHistory, saveResult } from './services/historyService'
import type { DetectionResult as Result } from './types/detection'
import type { Page } from './types/navigation'

const GENERIC_ERROR = 'Something went wrong while checking this image. Please try again.'

/**
 * Backend errors the user can act on. Anything else gets the generic message,
 * because a raw server string is rarely something a reviewer can do anything
 * about.
 */
const ACTIONABLE_CODES = new Set([
  'UNSUPPORTED_FORMAT',
  'IMAGE_TOO_LARGE',
  'DECODE_FAILED',
  'MODEL_UNAVAILABLE',
  'NETWORK_ERROR',
])

function messageFor(cause: unknown): string {
  if (cause instanceof ApiError && ACTIONABLE_CODES.has(cause.code)) return cause.message
  return GENERIC_ERROR
}

function App() {
  const [page, setPage] = useState<Page>('check')
  const [file, setFile] = useState<File | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [result, setResult] = useState<Result | null>(null)
  const [history, setHistory] = useState<Result[]>([])
  const [historyLoading, setHistoryLoading] = useState(true)
  const [processing, setProcessing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')
  const [mobileMenu, setMobileMenu] = useState(false)

  useEffect(() => () => revokeIfObjectUrl(previewUrl), [previewUrl])

  const refreshHistory = useCallback(async () => {
    try {
      setHistory(await loadHistory())
    } catch (cause) {
      // The history list is not worth blocking the app over; the check page
      // still works with the backend's history unavailable.
      console.error('Could not load history:', cause)
    } finally {
      setHistoryLoading(false)
    }
  }, [])

  useEffect(() => {
    void refreshHistory()
  }, [refreshHistory])

  const selectFile = useCallback(
    (nextFile: File) => {
      revokeIfObjectUrl(previewUrl)
      setFile(nextFile)
      setPreviewUrl(URL.createObjectURL(nextFile))
      setResult(null)
      setSaved(false)
      setError('')
    },
    [previewUrl],
  )

  const removeFile = useCallback(() => {
    revokeIfObjectUrl(previewUrl)
    setFile(null)
    setPreviewUrl(null)
  }, [previewUrl])

  async function checkImage() {
    if (!file || !previewUrl) return

    setProcessing(true)
    setError('')

    try {
      const detected = await analyzeImage(file)
      // Nothing is saved yet, so the result has no server-side image to point
      // at. The object URL we already made for the preview stands in.
      setResult({ ...detected, imageUrl: previewUrl })
      setPage('check')
    } catch (cause) {
      console.error('Image check failed:', cause)
      setError(messageFor(cause))
    } finally {
      // In `finally` so a failed check can never leave the UI stuck in its
      // processing state with the check button disabled.
      setProcessing(false)
    }
  }

  function resetCheck() {
    removeFile()
    setResult(null)
    setSaved(false)
    setError('')
    setPage('check')
  }

  async function saveCurrentResult() {
    if (!result || !file || saved || saving) return

    setSaving(true)
    try {
      const stored = await saveResult(result, file)
      // Swap in the server's copy so the image now loads from the API rather
      // than an object URL that dies with this page.
      setResult(stored)
      setSaved(true)
      await refreshHistory()
    } catch (cause) {
      console.error('Could not save result:', cause)
      setError('This result could not be saved. Please try again.')
    } finally {
      setSaving(false)
    }
  }

  function openResult(nextResult: Result) {
    setResult(nextResult)
    // A result opened from history is the server's; there is no local file
    // behind it, so it cannot be saved again.
    setFile(null)
    setPreviewUrl(null)
    setSaved(true)
    setError('')
    setPage('check')
  }

  function navigate(nextPage: Page) {
    setPage(nextPage)
    setMobileMenu(false)
  }

  async function handleClearHistory() {
    if (!window.confirm('Clear every saved check? This cannot be undone.')) return

    try {
      await clearHistory()
      await refreshHistory()
    } catch (cause) {
      console.error('Could not clear history:', cause)
    }
  }

  return (
    <div className="app-shell">
      <SiteHeader
        page={page}
        mobileMenuOpen={mobileMenu}
        onToggleMobileMenu={() => setMobileMenu(!mobileMenu)}
        onNavigate={navigate}
      />

      <main className="main-content">
        {page === 'check' &&
          (result ? (
            <DetectionResult
              result={result}
              onCheckAnother={resetCheck}
              onSave={() => void saveCurrentResult()}
              saved={saved}
              saving={saving}
              savable={file !== null}
            />
          ) : (
            <CheckPage
              file={file}
              previewUrl={previewUrl}
              processing={processing}
              error={error}
              onFile={selectFile}
              onRemove={removeFile}
              onCheck={() => void checkImage()}
            />
          ))}

        {page === 'results' && (
          <HistoryPage
            history={history}
            loading={historyLoading}
            onOpenResult={openResult}
            onClearHistory={() => void handleClearHistory()}
            onCheckAnother={() => navigate('check')}
          />
        )}

        {page === 'about' && <AboutPage />}
      </main>

      <SiteFooter />
    </div>
  )
}

export default App
