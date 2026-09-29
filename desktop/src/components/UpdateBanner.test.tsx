import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { UpdateBanner } from './UpdateBanner'

function renderBanner(overrides = {}) {
  const props = {
    version: '0.3.0',
    installing: false,
    error: '',
    onInstall: vi.fn(),
    onDismiss: vi.fn(),
    ...overrides,
  }
  render(<UpdateBanner {...props} />)
  return props
}

describe('UpdateBanner', () => {
  it('names the version and waits to be asked', async () => {
    const user = userEvent.setup()
    const props = renderBanner()

    expect(screen.getByText('Gavia 0.3.0 is ready.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Restart now' }))

    expect(props.onInstall).toHaveBeenCalledTimes(1)
  })

  it('can be put off', async () => {
    const user = userEvent.setup()
    const props = renderBanner()

    await user.click(screen.getByRole('button', { name: 'Later' }))

    expect(props.onDismiss).toHaveBeenCalledTimes(1)
  })

  it('holds still while installing', () => {
    renderBanner({ installing: true })

    expect(screen.getByRole('button', { name: /Installing/ })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Later' })).toBeDisabled()
  })

  it('explains a failed install in place of the prompt', () => {
    renderBanner({ error: 'It could not be installed here.' })

    expect(screen.getByText(/It could not be installed here/)).toBeInTheDocument()
    expect(screen.queryByText(/Restart to start using it/)).not.toBeInTheDocument()
  })
})
