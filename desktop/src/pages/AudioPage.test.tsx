import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AudioPage } from './AudioPage'

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
    audioUrl: null as string | null,
    processing: false,
    error: '',
    onFile,
    onRemove,
    onCheck,
    ...overrides,
  }
  return render(<AudioPage {...props} />)
}

const chosen = () => ({
  file: new File(['x'], 'lake.mp3', { type: 'audio/mpeg' }),
  audioUrl: 'blob:lake',
})

describe('before a recording is chosen', () => {
  it('explains what the page is for', () => {
    renderPage()
    expect(screen.getByRole('heading', { name: /Is that a loon\?/ })).toBeInTheDocument()
  })

  it('offers nothing to listen to yet', () => {
    renderPage()
    expect(screen.queryByRole('button', { name: /Listen for loon calls/ })).not.toBeInTheDocument()
  })
})

describe('once a recording is chosen', () => {
  it('listens when asked', async () => {
    const user = userEvent.setup()
    renderPage(chosen())

    await user.click(screen.getByRole('button', { name: /Listen for loon calls/ }))

    expect(onCheck).toHaveBeenCalledTimes(1)
  })

  it('says it is listening and cannot be started twice', () => {
    renderPage({ ...chosen(), processing: true })

    expect(screen.getByRole('button', { name: /Listening/ })).toBeDisabled()
    expect(screen.getByRole('status')).toHaveTextContent(/listening closely/)
  })

  it('shows what went wrong', () => {
    renderPage({ ...chosen(), error: 'That recording could not be read.' })
    expect(screen.getByRole('alert')).toHaveTextContent('That recording could not be read.')
  })
})
