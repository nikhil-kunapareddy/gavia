import { FolderOpen, Monitor, Moon, RotateCcw, Sun } from 'lucide-react'
import type { AppSettings, ModelEntry, ModelStatus, ThemeChoice } from '../types/settings'

export type SettingsBusy = 'storage' | 'model' | null

interface SettingsPageProps {
  theme: ThemeChoice
  onThemeChange: (theme: ThemeChoice) => void
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

function modelLabel(model: ModelEntry): string {
  return model.custom ? `${model.name} (added)` : model.name
}

/** A ready model says nothing; only loading and failure need a word. */
function modelStatusText(status: Exclude<ModelStatus, 'ok'>): string {
  return status === 'starting' ? 'Loading…' : 'Could not load this model'
}

export function SettingsPage({
  theme,
  onThemeChange,
  settings,
  error,
  busy,
  onChooseDataDir,
  onResetDataDir,
  onOpenFolder,
  onSelectModel,
}: SettingsPageProps) {
  const selected = settings?.models.find((model) => model.id === settings.model)

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
          <p>The model Gavia uses to find loons in your photos.</p>
        </div>
        {settings ? (
          <div className="settings-control">
            {/* A choice only appears once a second model has been added. */}
            {settings.models.length > 1 ? (
              <label className="settings-field">
                <span>Model</span>
                <select
                  value={settings.model}
                  onChange={(event) => onSelectModel(event.target.value)}
                  disabled={busy === 'model' || settings.modelStatus === 'starting'}
                >
                  {settings.models.map((model) => (
                    <option key={model.id} value={model.id}>
                      {modelLabel(model)}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <p className="settings-value">{selected?.name ?? settings.model}</p>
            )}
            {settings.modelStatus !== 'ok' && (
              <p className={`model-status model-status-${settings.modelStatus}`}>
                <span className="status-light" aria-hidden="true" />
                {modelStatusText(settings.modelStatus)}
              </p>
            )}
          </div>
        ) : (
          <p className="settings-hint">Loading…</p>
        )}
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
