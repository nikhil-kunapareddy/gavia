import { FolderOpen, Monitor, Moon, RotateCcw, Sun } from 'lucide-react'
import { ModelPicker } from '../components/ModelPicker'
import type { AppSettings, ThemeChoice } from '../types/settings'

export type SettingsBusy = 'storage' | 'model' | null

interface SettingsPageProps {
  theme: ThemeChoice
  onThemeChange: (theme: ThemeChoice) => void
  autoUpdate: boolean
  onAutoUpdateChange: (on: boolean) => void
  settings: AppSettings | null
  error: string
  busy: SettingsBusy
  onChooseDataDir: () => void
  onResetDataDir: () => void
  onOpenFolder: (which: 'data' | 'models') => void
  onSelectModel: (id: string) => void
}

const THEMES: { value: ThemeChoice; label: string; icon: typeof Sun }[] = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'system', label: 'System', icon: Monitor },
]

export function SettingsPage({
  theme,
  onThemeChange,
  autoUpdate,
  onAutoUpdateChange,
  settings,
  error,
  busy,
  onChooseDataDir,
  onResetDataDir,
  onOpenFolder,
  onSelectModel,
}: SettingsPageProps) {
  return (
    <section className="settings-page">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Make it yours</p>
          <h1>Settings</h1>
        </div>
      </div>

      {error && (
        <p className="settings-error" role="alert">
          {error}
        </p>
      )}

      <div className="settings-section">
        <div className="settings-label">
          <h2>Appearance</h2>
          <p>System follows your computer&apos;s light or dark setting.</p>
        </div>
        <div className="theme-options" role="radiogroup" aria-label="Theme">
          {THEMES.map(({ value, label, icon: Icon }) => (
            <button
              key={value}
              role="radio"
              aria-checked={theme === value}
              className={theme === value ? 'theme-option selected' : 'theme-option'}
              onClick={() => onThemeChange(value)}
            >
              <Icon size={17} />
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="settings-section">
        <div className="settings-label">
          <h2>Storage location</h2>
          <p>
            Where your saved checks, original photos and thumbnails are kept. Choosing a new folder
            moves them there; choosing a folder that already has Gavia history switches to it.
          </p>
        </div>
        {settings ? (
          <div className="settings-control">
            <code className="path-display" title={settings.dataDir}>
              {settings.dataDir}
            </code>
            <p className="settings-hint">
              {settings.savedChecks === 1
                ? '1 saved check'
                : `${settings.savedChecks} saved checks`}
              {settings.isDefaultDataDir ? ' · default location' : ''}
            </p>
            {settings.dataDirLocked ? (
              <p className="settings-hint">
                Set by GAVIA_DATA_DIR, so it can&apos;t be changed here.
              </p>
            ) : null}
            <div className="settings-actions">
              <button className="button button-outline" onClick={() => onOpenFolder('data')}>
                <FolderOpen size={16} /> Open folder
              </button>
              {!settings.dataDirLocked && (
                <button
                  className="button button-dark"
                  onClick={onChooseDataDir}
                  disabled={busy === 'storage'}
                >
                  {busy === 'storage' ? 'Moving…' : 'Change…'}
                </button>
              )}
              {!settings.dataDirLocked && !settings.isDefaultDataDir && (
                <button
                  className="button button-quiet"
                  onClick={onResetDataDir}
                  disabled={busy === 'storage'}
                >
                  <RotateCcw size={15} /> Use default
                </button>
              )}
            </div>
          </div>
        ) : (
          <p className="settings-hint">Loading…</p>
        )}
      </div>

      <div className="settings-section">
        <div className="settings-label">
          <h2>Detection model</h2>
          <p>
            The model Gavia checks your photos with: loons, or invasive lake plants. The Check page
            offers the same choice.
          </p>
        </div>
        {settings ? (
          <div className="settings-control">
            <ModelPicker settings={settings} disabled={busy === 'model'} onSelect={onSelectModel} />
          </div>
        ) : (
          <p className="settings-hint">Loading…</p>
        )}
      </div>

      <div className="settings-section">
        <div className="settings-label">
          <h2>Updates</h2>
          <p>
            When Gavia starts, it asks GitHub for a newer release and downloads it in the
            background. That is the only thing Gavia sends over the internet; your photos never
            leave this computer.
          </p>
        </div>
        <div className="settings-control">
          <label className="settings-toggle">
            <input
              type="checkbox"
              checked={autoUpdate}
              onChange={(event) => onAutoUpdateChange(event.target.checked)}
            />
            Check for updates when Gavia starts
          </label>
        </div>
      </div>

      {settings && (
        <div className="settings-section">
          <div className="settings-label">
            <h2>App version</h2>
          </div>
          <p className="settings-value">{settings.version}</p>
        </div>
      )}
    </section>
  )
}
