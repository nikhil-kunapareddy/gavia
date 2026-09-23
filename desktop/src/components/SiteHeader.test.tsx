import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SiteHeader } from './SiteHeader'

const onNavigate = vi.fn()
const onToggleMobileMenu = vi.fn()

beforeEach(() => {
  onNavigate.mockReset()
  onToggleMobileMenu.mockReset()
})

function renderHeader(overrides = {}) {
  return render(
    <SiteHeader
      page="check"
      mobileMenuOpen={false}
      onToggleMobileMenu={onToggleMobileMenu}
      onNavigate={onNavigate}
      {...overrides}
    />,
  )
}

describe('navigation', () => {
  it.each([
    ['Check an image', 'check'],
    ['Previous checks', 'results'],
    ['Settings', 'settings'],
    ['Help', 'help'],
  ])('navigates to %s', async (label, page) => {
    const user = userEvent.setup()
    renderHeader()

    const nav = screen.getByRole('navigation')
    await user.click(within(nav).getByRole('button', { name: new RegExp(label) }))

    expect(onNavigate).toHaveBeenCalledWith(page)
  })

  it('marks the current page so you can tell where you are', () => {
    renderHeader({ page: 'results' })

    const nav = screen.getByRole('navigation')
    const current = within(nav).getByRole('button', { name: /Previous checks/ })
    const other = within(nav).getByRole('button', { name: /Settings/ })

    expect(current.className).toContain('active')
    expect(other.className).not.toContain('active')
  })

  it('sends the brand back to the check page', async () => {
    const user = userEvent.setup()
    renderHeader({ page: 'settings' })

    await user.click(screen.getByRole('button', { name: 'Go to check an image' }))

    expect(onNavigate).toHaveBeenCalledWith('check')
  })
})

describe('the mobile menu', () => {
  it('reports whether it is open to assistive technology', () => {
    const { rerender } = renderHeader()
    expect(screen.getByRole('button', { name: 'Toggle navigation' })).toHaveAttribute(
      'aria-expanded',
      'false',
    )

    rerender(
      <SiteHeader
        page="check"
        mobileMenuOpen
        onToggleMobileMenu={onToggleMobileMenu}
        onNavigate={onNavigate}
      />,
    )
    expect(screen.getByRole('button', { name: 'Toggle navigation' })).toHaveAttribute(
      'aria-expanded',
      'true',
    )
  })

  it('toggles when tapped', async () => {
    const user = userEvent.setup()
    renderHeader()

    await user.click(screen.getByRole('button', { name: 'Toggle navigation' }))

    expect(onToggleMobileMenu).toHaveBeenCalledTimes(1)
  })

  it('opens the nav panel', () => {
    renderHeader({ mobileMenuOpen: true })
    expect(screen.getByRole('navigation').className).toContain('nav-open')
  })
})
