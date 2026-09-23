/** Mirrors `SettingsView` and `ModelEntry` in `src-tauri/src/service.rs` and `models.rs`. */

export interface ModelEntry {
  /** The file stem, e.g. `loon_v1`. */
  id: string
  name: string
  architecture: string
  classes: string[]
  metrics: Record<string, number>
  /** True for a model added to the models folder, false for one shipped with the app. */
  custom: boolean
}

export type ModelStatus = 'starting' | 'ok' | 'degraded'

export interface AppSettings {
  dataDir: string
  defaultDataDir: string
  isDefaultDataDir: boolean
  /** Set by the GAVIA_DATA_DIR environment variable, so it can't be changed here. */
  dataDirLocked: boolean
  modelsDir: string
  /** The chosen model's id. */
  model: string
  models: ModelEntry[]
  modelStatus: ModelStatus
  savedChecks: number
  version: string
}

export type ThemeChoice = 'light' | 'dark' | 'system'
