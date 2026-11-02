import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { AppSettings, ModelEntry } from '../types/settings'
import { ModelPicker } from './ModelPicker'

const loons: ModelEntry = {
  id: 'loon_v1',
  name: 'Loonet 1.0',
  architecture: 'YOLO11s',
  classes: ['common loon'],
  subject: { one: 'loon', many: 'loons' },
  metrics: {},
  custom: false,
}

const plants: ModelEntry = {
  id: 'veg_v1',
  name: 'Vegnet 1.0',
  architecture: 'YOLO26s',
  classes: ['purple loosestrife', 'common reed', 'water chestnut', 'yellow flag iris'],
  subject: { one: 'invasive plant', many: 'invasive plants' },
  metrics: {},
  custom: false,
}

function settings(overrides: Partial<AppSettings> = {}): AppSettings {
  return {
    dataDir: '/data',
    defaultDataDir: '/data',
    isDefaultDataDir: true,
    dataDirLocked: false,
    modelsDir: '/data/models',
    model: 'loon_v1',
    models: [loons, plants],
    modelStatus: 'ok',
    savedChecks: 0,
    version: '0.4.0',
    ...overrides,
  }
}

describe('ModelPicker', () => {
  it('shows the chosen model and what it looks for', () => {
    render(<ModelPicker settings={settings()} onSelect={vi.fn()} />)
    const menu = screen.getByRole('combobox', { name: 'Model' })
    expect(menu).toHaveTextContent('Loonet 1.0Loons')
    expect(menu).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('option')).not.toBeInTheDocument()
  })

  it('names each model and what it looks for, with the chosen one marked', async () => {
    const user = userEvent.setup()
    render(<ModelPicker settings={settings()} onSelect={vi.fn()} />)
    await user.click(screen.getByRole('combobox', { name: 'Model' }))
    const list = screen.getByRole('listbox', { name: 'Model' })
    expect(
      within(list)
        .getAllByRole('option')
        .map((option) => option.getAttribute('aria-label')),
    ).toEqual(['Loonet 1.0 · Loons', 'Vegnet 1.0 · Invasive plants'])
    expect(screen.getByRole('option', { selected: true })).toHaveAccessibleName(
      'Loonet 1.0 · Loons',
    )
    // The species, for a model that finds more than one kind of thing.
    expect(
      within(list).getByText('Purple loosestrife, common reed, water chestnut, yellow flag iris'),
    ).toBeInTheDocument()
  })

  it('marks a model the user added', async () => {
    const user = userEvent.setup()
    const mine = { ...loons, id: 'mine', name: 'mine', custom: true }
    render(<ModelPicker settings={settings({ models: [loons, mine] })} onSelect={vi.fn()} />)
    await user.click(screen.getByRole('combobox', { name: 'Model' }))
    expect(screen.getByRole('option', { name: 'mine (added) · Loons' })).toHaveTextContent(
      'mineAdded',
    )
  })

  it('reports the choice and closes', async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn()
    render(<ModelPicker settings={settings()} onSelect={onSelect} />)
    await user.click(screen.getByRole('combobox', { name: 'Model' }))
    await user.click(screen.getByRole('option', { name: 'Vegnet 1.0 · Invasive plants' }))
    expect(onSelect).toHaveBeenCalledWith('veg_v1')
    expect(screen.queryByRole('option')).not.toBeInTheDocument()
  })

  it('reports nothing when the chosen model is picked again', async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn()
    render(<ModelPicker settings={settings()} onSelect={onSelect} />)
    await user.click(screen.getByRole('combobox', { name: 'Model' }))
    await user.click(screen.getByRole('option', { name: 'Loonet 1.0 · Loons' }))
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('closes on a second click', async () => {
    const user = userEvent.setup()
    render(<ModelPicker settings={settings()} onSelect={vi.fn()} />)
    const menu = screen.getByRole('combobox', { name: 'Model' })
    await user.click(menu)
    await user.click(menu)
    expect(menu).toHaveAttribute('aria-expanded', 'false')
  })

  it('works from the keyboard', async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn()
    const third = { ...loons, id: 'mine', name: 'mine', custom: true }
    render(
      <ModelPicker settings={settings({ models: [loons, plants, third] })} onSelect={onSelect} />,
    )
    const menu = screen.getByRole('combobox', { name: 'Model' })
    const active = () => document.getElementById(menu.getAttribute('aria-activedescendant') ?? '')

    // Keys other than the arrows leave a closed menu to the button.
    menu.focus()
    await user.keyboard('a')
    expect(menu).toHaveAttribute('aria-expanded', 'false')

    // An arrow opens it on the chosen model; the arrows stop at the ends.
    await user.keyboard('{ArrowDown}')
    expect(menu).toHaveAttribute('aria-expanded', 'true')
    expect(active()).toHaveAccessibleName('Loonet 1.0 · Loons')
    await user.keyboard('{ArrowUp}')
    expect(active()).toHaveAccessibleName('Loonet 1.0 · Loons')
    await user.keyboard('{End}{ArrowDown}')
    expect(active()).toHaveAccessibleName('mine (added) · Loons')
    await user.keyboard('{Home}{ArrowDown}a')
    expect(active()).toHaveAccessibleName('Vegnet 1.0 · Invasive plants')

    // Escape closes without choosing.
    await user.keyboard('{Escape}')
    expect(menu).toHaveAttribute('aria-expanded', 'false')
    expect(menu).not.toHaveAttribute('aria-activedescendant')
    expect(onSelect).not.toHaveBeenCalled()

    // Enter picks; so does Space.
    await user.keyboard('{ArrowUp}{ArrowDown}{Enter}')
    expect(onSelect).toHaveBeenLastCalledWith('veg_v1')
    await user.keyboard('{ArrowDown}{End} ')
    expect(onSelect).toHaveBeenLastCalledWith('mine')
  })

  it('follows the pointer', async () => {
    const user = userEvent.setup()
    render(<ModelPicker settings={settings()} onSelect={vi.fn()} />)
    const menu = screen.getByRole('combobox', { name: 'Model' })
    await user.click(menu)
    await user.hover(screen.getByRole('option', { name: 'Vegnet 1.0 · Invasive plants' }))
    expect(document.getElementById(menu.getAttribute('aria-activedescendant') ?? '')).toHaveClass(
      'active',
    )
  })

  it('closes when focus moves away', async () => {
    const user = userEvent.setup()
    render(
      <>
        <ModelPicker settings={settings()} onSelect={vi.fn()} />
        <button>Elsewhere</button>
      </>,
    )
    const menu = screen.getByRole('combobox', { name: 'Model' })
    await user.click(menu)
    await user.tab()
    expect(screen.getByRole('button', { name: 'Elsewhere' })).toHaveFocus()
    expect(menu).toHaveAttribute('aria-expanded', 'false')
  })

  it('waits while a model loads, and says so', () => {
    render(<ModelPicker settings={settings({ modelStatus: 'starting' })} onSelect={vi.fn()} />)
    expect(screen.getByRole('combobox', { name: 'Model' })).toBeDisabled()
    expect(screen.getByText('Loading…')).toBeInTheDocument()
  })

  it('can be disabled from outside, as during a check', () => {
    render(<ModelPicker settings={settings()} disabled onSelect={vi.fn()} />)
    expect(screen.getByRole('combobox', { name: 'Model' })).toBeDisabled()
  })

  it('says when a model could not be loaded', () => {
    render(<ModelPicker settings={settings({ modelStatus: 'degraded' })} onSelect={vi.fn()} />)
    expect(screen.getByText('Could not load this model')).toBeInTheDocument()
  })

  it('gives a model that finds something else a neutral icon', async () => {
    const user = userEvent.setup()
    const birds = { ...loons, id: 'birds', name: 'Birds', subject: { one: 'bird', many: 'birds' } }
    render(<ModelPicker settings={settings({ models: [loons, birds] })} onSelect={vi.fn()} />)
    await user.click(screen.getByRole('combobox', { name: 'Model' }))
    expect(screen.getByRole('option', { name: 'Birds · Birds' })).toBeInTheDocument()
  })

  it('shows just the name when there is nothing to choose between', () => {
    render(<ModelPicker settings={settings({ models: [loons] })} onSelect={vi.fn()} />)
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
    expect(screen.getByText('Loonet 1.0')).toBeInTheDocument()
  })
})
