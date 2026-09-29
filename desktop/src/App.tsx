import { useCallback, useEffect, useRef, useState } from 'react'
import { DetectionResult } from './components/DetectionResult'
import { SiteFooter } from './components/SiteFooter'
import { SiteHeader } from './components/SiteHeader'
import { describeSkipped, type Skipped } from './lib/batch'
import { revokeIfObjectUrl } from './lib/imageFile'
import { applyTheme, readTheme, saveTheme } from './lib/theme'
import { BatchPage } from './pages/BatchPage'
import { CheckPage } from './pages/CheckPage'
import { HelpPage } from './pages/HelpPage'
import { HistoryPage } from './pages/HistoryPage'
import { SettingsPage, type SettingsBusy } from './pages/SettingsPage'
import { ApiError } from './services/api'
import { analyzeImage } from './services/detectionService'
import { confirmAction } from './services/dialog'
import { clearHistory, loadHistory, saveResult } from './services/historyService'
import {
  chooseDataDir,
  getSettings,
  openFolder,
  resetDataDir,
  selectModel,
} from './services/settingsService'
import type { BatchBusy, BatchItem } from './types/batch'
import type { DetectionResult as Result } from './types/detection'
import type { Page } from './types/navigation'
import type { AppSettings, ThemeChoice } from './types/settings'

/** How often to re-read settings while a newly chosen model loads. */
const MODEL_POLL_MS = 600

const GENERIC_ERROR = 'Something went wrong while checking this image. Please try again.'

/**
 * Core errors the user can act on. Anything else gets the generic message,
 * because a raw internal string is rarely something a reviewer can do anything
 * about.
 */
const ACTIONABLE_CODES = new Set([
  'UNSUPPORTED_FORMAT',
  'IMAGE_TOO_LARGE',
  'DECODE_FAILED',
  'MODEL_UNAVAILABLE',
])

function messageFor(cause: unknown): string {
  if (cause instanceof ApiError && ACTIONABLE_CODES.has(cause.code)) return cause.message
  return GENERIC_ERROR
}

/**
 * Settings errors worth showing as written: the core explains why a folder
 * can't be used ("already has a Gavia folder that isn't a history…") or that
 * a model has gone missing.
 */
const SETTINGS_CODES = new Set(['INVALID_REQUEST', 'NOT_FOUND', 'MODEL_UNAVAILABLE'])

function settingsMessage(cause: unknown, fallback: string): string {
  if (cause instanceof ApiError && SETTINGS_CODES.has(cause.code)) return cause.message
  return fallback
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
  const [notice, setNotice] = useState('')
  const [batch, setBatch] = useState<BatchItem[]>([])
  const [batchBusy, setBatchBusy] = useState<BatchBusy>(null)
  const [batchError, setBatchError] = useState('')
  const [openKey, setOpenKey] = useState<string | null>(null)
  // Read by the running check between images, so it can't be state.
  const stopRequested = useRef(false)
  const [mobileMenu, setMobileMenu] = useState(false)
  const [theme, setTheme] = useState<ThemeChoice>(readTheme)
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [settingsError, setSettingsError] = useState('')
  const [settingsBusy, setSettingsBusy] = useState<SettingsBusy>(null)

  // Returns the cleanup, which stops following the system when the choice
  // changes away from "system".
  useEffect(() => applyTheme(theme), [theme])

  function changeTheme(next: ThemeChoice) {
    saveTheme(next)
    setTheme(next)
  }

  const refreshSettings = useCallback(async () => {
    try {
      setSettings(await getSettings())
    } catch (cause) {
      console.error('Could not load settings:', cause)
      setSettingsError(settingsMessage(cause, 'Settings could not be loaded.'))
    }
  }, [])

  useEffect(() => {
    if (page === 'settings') void refreshSettings()
  }, [page, refreshSettings])

  // A newly chosen model loads in the background; keep asking until it's done.
  useEffect(() => {
    if (settings?.modelStatus !== 'starting') return
    const timer = setTimeout(() => void refreshSettings(), MODEL_POLL_MS)
    return () => clearTimeout(timer)
  }, [settings, refreshSettings])

  async function runSetting(busy: SettingsBusy, action: () => Promise<AppSettings | null>) {
    setSettingsBusy(busy)
    setSettingsError('')
    try {
      const next = await action()
      if (next) {
        setSettings(next)
        // History may now come from a different folder.
        if (busy === 'storage') await refreshHistory()
      }
    } catch (cause) {
      console.error('Could not change settings:', cause)
      setSettingsError(
        settingsMessage(cause, 'That setting could not be changed. Please try again.'),
      )
    } finally {
      setSettingsBusy(null)
    }
  }

  async function showFolder(which: 'data' | 'models') {
    try {
      await openFolder(which)
    } catch (cause) {
      console.error('Could not open the folder:', cause)
      setSettingsError(settingsMessage(cause, 'The folder could not be opened.'))
    }
  }

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

  function clearBatch() {
    batch.forEach((item) => revokeIfObjectUrl(item.previewUrl))
    setBatch([])
    setBatchError('')
    setOpenKey(null)
  }

  /** One image goes through the single check; several make a batch. */
  function chooseFiles(images: File[], skipped: Skipped[]) {
    setNotice(describeSkipped(skipped))
    clearBatch()
    if (images.length === 1) {
      selectFile(images[0])
      return
    }
    removeFile()
    setResult(null)
    setSaved(false)
    setError('')
    setBatch(
      images.map((image, index) => ({
        key: `${index}-${image.name}`,
        file: image,
        previewUrl: URL.createObjectURL(image),
        status: 'waiting',
      })),
    )
  }

  function updateItem(key: string, patch: Partial<BatchItem>) {
    setBatch((items) => items.map((item) => (item.key === key ? { ...item, ...patch } : item)))
  }

  /**
   * Check every image not yet checked, one at a time.
   *
   * One after another rather than all at once: the core runs one inference at
   * a time anyway, and this way progress is visible, Stop takes effect
   * between images, and one bad file doesn't take the rest down with it.
   */
  async function checkBatch() {
    stopRequested.current = false
    setBatchBusy('checking')
    setBatchError('')
    try {
      for (const item of batch) {
        if (stopRequested.current) break
        if (item.status === 'done') continue
        updateItem(item.key, { status: 'checking', error: undefined })
        try {
          const detected = await analyzeImage(item.file)
          updateItem(item.key, {
            status: 'done',
            result: { ...detected, imageUrl: item.previewUrl },
          })
        } catch (cause) {
          console.error(`Checking ${item.file.name} failed:`, cause)
          updateItem(item.key, { status: 'failed', error: messageFor(cause) })
          // Every image after this one would fail the same way.
          if (cause instanceof ApiError && cause.code === 'MODEL_UNAVAILABLE') {
            setBatchError(cause.message)
            break
          }
        }
      }
    } finally {
      setBatchBusy(null)
    }
  }

  function stopBatch() {
    stopRequested.current = true
    setBatchBusy('stopping')
  }

  /** Save one checked image; false if it could not be saved. */
  async function saveItem(item: BatchItem): Promise<boolean> {
    if (!item.result || item.result.saved) return true
    updateItem(item.key, { saving: true })
    try {
      const stored = await saveResult(item.result, item.file)
      updateItem(item.key, { saving: false, result: stored })
      return true
    } catch (cause) {
      console.error(`Could not save ${item.file.name}:`, cause)
      updateItem(item.key, { saving: false })
      return false
    }
  }

  async function saveOpenItem(item: BatchItem) {
    setBatchError('')
    if (!(await saveItem(item))) setBatchError('This result could not be saved. Please try again.')
    await refreshHistory()
  }

  async function saveBatch() {
    setBatchBusy('saving')
    setBatchError('')
    try {
      let failed = 0
      for (const item of batch) {
        if (!item.result?.detections.length) continue
        if (!(await saveItem(item))) failed += 1
      }
      if (failed > 0) {
        setBatchError(
          `${failed === 1 ? '1 result' : `${failed} results`} could not be saved. Please try again.`,
        )
      }
      await refreshHistory()
    } finally {
      setBatchBusy(null)
    }
  }

  function startOver() {
    clearBatch()
    setNotice('')
  }

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
    // A history result opened over a batch goes back to the batch.
    if (batch.length === 0) setNotice('')
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
    setOpenKey(null)
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
    const confirmed = await confirmAction(
      'Clear every saved check? This cannot be undone.',
      'Clear history',
    )
    if (!confirmed) return

    try {
      await clearHistory()
      await refreshHistory()
    } catch (cause) {
      console.error('Could not clear history:', cause)
    }
  }

  const openItem = batch.find((item) => item.key === openKey)

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
          (openItem?.result ? (
            <DetectionResult
              key={openItem.key}
              result={openItem.result}
              onCheckAnother={() => setOpenKey(null)}
              onSave={() => void saveOpenItem(openItem)}
              saved={openItem.result.saved}
              saving={openItem.saving}
              backLabel="Back to all images"
            />
          ) : result ? (
            <DetectionResult
              result={result}
              onCheckAnother={resetCheck}
              onSave={() => void saveCurrentResult()}
              saved={saved}
              saving={saving}
              savable={file !== null}
            />
          ) : batch.length > 0 ? (
            <BatchPage
              items={batch}
              busy={batchBusy}
              notice={notice}
              error={batchError}
              onCheck={() => void checkBatch()}
              onStop={stopBatch}
              onSaveAll={() => void saveBatch()}
              onStartOver={startOver}
              onOpen={setOpenKey}
            />
          ) : (
            <CheckPage
              file={file}
              previewUrl={previewUrl}
              processing={processing}
              error={error}
              notice={notice}
              onFiles={chooseFiles}
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

        {page === 'settings' && (
          <SettingsPage
            theme={theme}
            onThemeChange={changeTheme}
            settings={settings}
            error={settingsError}
            busy={settingsBusy}
            onChooseDataDir={() =>
              void runSetting('storage', () => chooseDataDir(settings?.dataDir ?? ''))
            }
            onResetDataDir={() => void runSetting('storage', resetDataDir)}
            onOpenFolder={(which) => void showFolder(which)}
            onSelectModel={(id) => void runSetting('model', () => selectModel(id))}
          />
        )}

        {page === 'help' && <HelpPage />}
      </main>

      <SiteFooter />
    </div>
  )
}

export default App
