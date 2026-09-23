import { useCallback, useEffect, useState } from 'react'
import { DetectionResult } from './components/DetectionResult'
import { SiteFooter } from './components/SiteFooter'
import { SiteHeader } from './components/SiteHeader'
import { revokeIfObjectUrl } from './lib/imageFile'
import { applyTheme, readTheme, saveTheme } from './lib/theme'
import { CheckPage } from './pages/CheckPage'
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
      </main>

      <SiteFooter />
    </div>
  )
}

export default App
