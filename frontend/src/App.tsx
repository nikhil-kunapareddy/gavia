import { useCallback, useEffect, useState } from 'react'
import { DetectionResult } from './components/DetectionResult'
import { SiteFooter } from './components/SiteFooter'
import { SiteHeader } from './components/SiteHeader'
import { imageToDataUrl, revokeIfObjectUrl } from './lib/imageFile'
import { AboutPage } from './pages/AboutPage'
import { CheckPage } from './pages/CheckPage'
import { HistoryPage } from './pages/HistoryPage'
import { analyzeImage } from './services/detectionService'
import { clearHistory, loadHistory, saveHistory } from './services/historyService'
import type { DetectionResult as Result } from './types/detection'
import type { Page } from './types/navigation'

const GENERIC_ERROR = 'Something went wrong while checking this image. Please try again.'

function App() {
  const [page, setPage] = useState<Page>('check')
  const [file, setFile] = useState<File | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [result, setResult] = useState<Result | null>(null)
  const [history, setHistory] = useState<Result[]>(loadHistory)
  const [processing, setProcessing] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')
  const [mobileMenu, setMobileMenu] = useState(false)

  useEffect(() => () => revokeIfObjectUrl(previewUrl), [previewUrl])

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
      const dataUrl = await imageToDataUrl(file)
      setResult(await analyzeImage(file, dataUrl))
      setPage('check')
    } catch (cause) {
      console.error('Image check failed:', cause)
      setError(GENERIC_ERROR)
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

  function saveCurrentResult() {
    if (!result) return
    const next = saveHistory(result)
    setHistory(next)
    // Storage can shed entries under quota pressure, so confirm the result
    // actually landed before telling the user it was saved.
    setSaved(next.some((item) => item.id === result.id))
  }

  function openResult(nextResult: Result) {
    setResult(nextResult)
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

  function handleClearHistory() {
    if (!window.confirm('Clear saved checks? Demo samples will stay available.')) return
    clearHistory()
    setHistory(loadHistory())
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
              onSave={saveCurrentResult}
              saved={saved}
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
            onOpenResult={openResult}
            onClearHistory={handleClearHistory}
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
