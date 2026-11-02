import { Bird, Check, ChevronDown, Leaf, LoaderCircle, ScanSearch } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useId, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { capitalize, LOONS } from '../lib/format'
import type { Subject } from '../types/detection'
import type { AppSettings, ModelEntry, ModelStatus } from '../types/settings'

interface ModelPickerProps {
  settings: AppSettings
  /** Disabled while a choice is being saved; a model that is loading disables it too. */
  disabled?: boolean
  onSelect: (id: string) => void
}

/** "Loonet 1.0 · Loons", "my_retrain (added) · Loons": each option's spoken name. */
function modelLabel(model: ModelEntry): string {
  const name = model.custom ? `${model.name} (added)` : model.name
  return `${name} · ${capitalize(model.subject.many)}`
}

/** A bird for loons, a leaf for plants, a magnifier for anything else. */
function subjectIcon(subject: Subject): LucideIcon {
  if (subject.one === LOONS.one) return Bird
  if (subject.one.includes('plant')) return Leaf
  return ScanSearch
}

/** A ready model says nothing; only loading and failure need a word. */
function statusText(status: Exclude<ModelStatus, 'ok'>): string {
  return status === 'starting' ? 'Loading…' : 'Could not load this model'
}

/** Icon, name and what it finds: the menu button and each option alike. */
function ModelSummary({ model, details = false }: { model: ModelEntry; details?: boolean }) {
  const Icon = subjectIcon(model.subject)
  return (
    <>
      <span className="model-icon" aria-hidden="true">
        <Icon size={18} />
      </span>
      <span className="model-text">
        <span className="model-name">
          {model.name}
          {model.custom && <span className="model-tag">Added</span>}
        </span>
        <span className="model-subject">{capitalize(model.subject.many)}</span>
        {details && model.classes.length > 1 && (
          <span className="model-classes">{capitalize(model.classes.join(', '))}</span>
        )}
      </span>
    </>
  )
}

/**
 * Which photo model checks run with: a menu once there is more than one, the
 * model's name otherwise, and a word while it loads or if it failed to.
 * The same choice on the Check page and in Settings.
 *
 * The menu is a select-only combobox (WAI-ARIA): focus stays on the button,
 * the arrow keys move through the options, Enter or Space picks one, and
 * Escape or leaving closes it.
 */
export function ModelPicker({ settings, disabled = false, onSelect }: ModelPickerProps) {
  const id = useId()
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const { models } = settings
  const chosen = Math.max(
    0,
    models.findIndex((model) => model.id === settings.model),
  )
  const loading = settings.modelStatus === 'starting'
  const locked = disabled || loading
  const expanded = open && !locked
  const optionId = (index: number) => `${id}-option-${index}`

  function show() {
    setActive(chosen)
    setOpen(true)
  }

  function pick(index: number) {
    setOpen(false)
    if (models[index].id !== settings.model) onSelect(models[index].id)
  }

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (!expanded) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        show()
      }
      return
    }
    switch (event.key) {
      case 'ArrowDown':
        setActive((index) => Math.min(index + 1, models.length - 1))
        break
      case 'ArrowUp':
        setActive((index) => Math.max(index - 1, 0))
        break
      case 'Home':
        setActive(0)
        break
      case 'End':
        setActive(models.length - 1)
        break
      case 'Enter':
      case ' ':
        pick(active)
        break
      case 'Escape':
        setOpen(false)
        break
      default:
        return
    }
    event.preventDefault()
  }

  return (
    <div className="model-picker">
      {models.length > 1 ? (
        <div className="model-menu">
          <span id={`${id}-label`} className="model-menu-label">
            Model
          </span>
          <button
            type="button"
            role="combobox"
            className="model-menu-button"
            aria-labelledby={`${id}-label`}
            aria-haspopup="listbox"
            aria-expanded={expanded}
            aria-controls={`${id}-list`}
            aria-activedescendant={expanded ? optionId(active) : undefined}
            disabled={locked}
            onClick={() => (expanded ? setOpen(false) : show())}
            onKeyDown={onKeyDown}
            onBlur={() => setOpen(false)}
          >
            <ModelSummary model={models[chosen]} />
            {loading ? (
              <LoaderCircle className="model-menu-chevron spin" size={18} aria-hidden="true" />
            ) : (
              <ChevronDown className="model-menu-chevron" size={18} aria-hidden="true" />
            )}
          </button>
          <ul
            id={`${id}-list`}
            role="listbox"
            className="model-menu-list"
            aria-labelledby={`${id}-label`}
            hidden={!expanded}
            // Keep focus on the button, so a click on an option doesn't close the menu first.
            onMouseDown={(event) => event.preventDefault()}
          >
            {models.map((model, index) => (
              <li
                key={model.id}
                id={optionId(index)}
                role="option"
                className={index === active ? 'model-option active' : 'model-option'}
                aria-selected={index === chosen}
                aria-label={modelLabel(model)}
                onClick={() => pick(index)}
                onMouseEnter={() => setActive(index)}
              >
                <ModelSummary model={model} details />
                {index === chosen && (
                  <Check className="model-option-check" size={17} aria-hidden="true" />
                )}
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="settings-value">
          {models.find((model) => model.id === settings.model)?.name ?? settings.model}
        </p>
      )}
      {settings.modelStatus !== 'ok' && (
        <p className={`model-status model-status-${settings.modelStatus}`}>
          <span className="status-light" aria-hidden="true" />
          {statusText(settings.modelStatus)}
        </p>
      )}
    </div>
  )
}
