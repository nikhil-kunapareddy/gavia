import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CheckPage } from './CheckPage'

const onFile = vi.fn()
const onRemove = vi.fn()
const onCheck = vi.fn()

beforeEach(() => {
  onFile.mockReset()
  onRemove.mockReset()
  onCheck.mockReset()
})

function renderPage(overrides = {}) {
  const props = {
    file: null as File | null,
    previewUrl: null as string | null,
    processing: false,
    error: '',
    onFile,
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
    expect(screen.getByText(/Looking for loon-like features/i)).toBeInTheDocument()
  })
})

describe('when something went wrong', () => {
  it('shows the error as an alert so it is announced', () => {
    renderPage({ ...chosenFile(), error: 'Could not reach the detection service.' })

    expect(screen.getByRole('alert')).toHaveTextContent(
      'Could not reach the detection service.',
    )
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
