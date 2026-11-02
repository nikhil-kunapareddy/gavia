import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppSettings } from '../types/settings'
import { CheckPage } from './CheckPage'

const onFiles = vi.fn()
const onRemove = vi.fn()
const onCheck = vi.fn()

beforeEach(() => {
  onFiles.mockReset()
  onRemove.mockReset()
  onCheck.mockReset()
})

function renderPage(overrides = {}) {
  const props = {
    file: null as File | null,
    previewUrl: null as string | null,
    processing: false,
    error: '',
    onFiles,
    onRemove,
    onCheck,
    ...overrides,
  }
  return render(<CheckPage {...props} />)
}

function chosenFile() {
  return { file: new File(['x'], 'loon.jpg', { type: 'image/jpeg' }), previewUrl: 'blob:x' }
}

describe('before a file is chosen', () => {
  it('explains what the page is for', () => {
    renderPage()
    expect(screen.getByRole('heading', { name: /Is this a loon\?/ })).toBeInTheDocument()
  })

  it('offers no check button, since there is nothing to check', () => {
    renderPage()
    expect(screen.queryByRole('button', { name: /Check for loons/ })).not.toBeInTheDocument()
  })
})

describe('once a file is chosen', () => {
  it('offers to check it', () => {
    renderPage(chosenFile())
    expect(screen.getByRole('button', { name: /Check for loons/ })).toBeEnabled()
  })

  it('runs the check when asked', async () => {
    const user = userEvent.setup()
    renderPage(chosenFile())

    await user.click(screen.getByRole('button', { name: /Check for loons/ }))

    expect(onCheck).toHaveBeenCalledTimes(1)
  })
})

describe('while processing', () => {
  it('disables the button so the same image is not checked twice', async () => {
    const user = userEvent.setup()
    renderPage({ ...chosenFile(), processing: true })

    const button = screen.getByRole('button', { name: /Checking|Check for loons/ })
    expect(button).toBeDisabled()

    await user.click(button)
    expect(onCheck).not.toHaveBeenCalled()
  })

  it('says something is happening', () => {
    renderPage({ ...chosenFile(), processing: true })
    expect(screen.getByText(/Looking for loons in this photo/i)).toBeInTheDocument()
  })
})

describe('when something went wrong', () => {
  it('shows the error as an alert so it is announced', () => {
    renderPage({ ...chosenFile(), error: 'Could not reach the detection service.' })

    expect(screen.getByRole('alert')).toHaveTextContent('Could not reach the detection service.')
  })

  it('leaves the check button usable so the user can retry', () => {
    renderPage({ ...chosenFile(), error: 'Something went wrong.' })
    expect(screen.getByRole('button', { name: /Check for loons/ })).toBeEnabled()
  })

  it('shows nothing when there is no error', () => {
    renderPage(chosenFile())
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})

describe('when files were left out', () => {
  it('says which', () => {
    renderPage({ ...chosenFile(), notice: "Left out 1 file Gavia can't check: notes.txt." })
    expect(screen.getByText(/Left out 1 file/)).toBeInTheDocument()
  })
})

describe('choosing a model', () => {
  const models: AppSettings['models'] = [
    {
      id: 'loon_v1',
      name: 'Loonet 1.0',
      architecture: 'YOLO11s',
      classes: ['common loon'],
      subject: { one: 'loon', many: 'loons' },
      metrics: {},
      custom: false,
    },
    {
      id: 'veg_v1',
      name: 'Vegnet 1.0',
      architecture: 'YOLO26s',
      classes: ['purple loosestrife'],
      subject: { one: 'invasive plant', many: 'invasive plants' },
      metrics: {},
      custom: false,
    },
  ]
  const settings: AppSettings = {
    dataDir: '/data',
    defaultDataDir: '/data',
    isDefaultDataDir: true,
    dataDirLocked: false,
    modelsDir: '/data/models',
    model: 'veg_v1',
    models,
    modelStatus: 'ok',
    savedChecks: 0,
    version: '0.4.0',
  }
  const plants = { one: 'invasive plant', many: 'invasive plants' }

  it('offers the models and reports a choice', async () => {
    const user = userEvent.setup()
    const onSelectModel = vi.fn()
    renderPage({ settings, subject: plants, onSelectModel })

    await user.click(screen.getByRole('combobox', { name: 'Model' }))
    await user.click(screen.getByRole('option', { name: 'Loonet 1.0 · Loons' }))
    expect(onSelectModel).toHaveBeenCalledWith('loon_v1')
  })

  it('speaks of what the chosen model looks for', () => {
    renderPage({ settings, subject: plants, ...chosenFile() })
    expect(screen.getByRole('heading', { name: /Is this an invasive plant\?/ })).toBeInTheDocument()
    expect(screen.getByText(/whether an invasive plant is present/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Check for invasive plants/ })).toBeInTheDocument()
  })

  it('cannot change model mid-check', () => {
    renderPage({ settings, subject: plants, processing: true, ...chosenFile() })
    expect(screen.getByRole('combobox', { name: 'Model' })).toBeDisabled()
  })

  it('has no menu without settings, and looks for loons', () => {
    renderPage()
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /Is this a loon\?/ })).toBeInTheDocument()
  })
})
