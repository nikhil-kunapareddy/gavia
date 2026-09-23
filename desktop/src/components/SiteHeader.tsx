import { BookOpen, History, Menu, X } from 'lucide-react'
import type { Page } from '../types/navigation'

interface SiteHeaderProps {
  page: Page
  mobileMenuOpen: boolean
  onToggleMobileMenu: () => void
  onNavigate: (page: Page) => void
}

function navClass(isActive: boolean): string {
  return isActive ? 'nav-link active' : 'nav-link'
}

export function SiteHeader({
  page,
  mobileMenuOpen,
  onToggleMobileMenu,
  onNavigate,
}: SiteHeaderProps) {
  return (
    <header className="site-header">
      <div className="header-inner">
        <button
          className="brand"
          onClick={() => onNavigate('check')}
          aria-label="Go to check an image"
        >
          <strong>Gavia</strong>
        </button>
        <nav
          className={`main-nav ${mobileMenuOpen ? 'nav-open' : ''}`}
          aria-label="Main navigation"
        >
          <button className={navClass(page === 'check')} onClick={() => onNavigate('check')}>
            Check an image
          </button>
          <button className={navClass(page === 'results')} onClick={() => onNavigate('results')}>
            <History size={16} /> Previous checks
          </button>
          <button className={navClass(page === 'about')} onClick={() => onNavigate('about')}>
            <BookOpen size={16} /> About
          </button>
        </nav>
        <button
          className="menu-button"
          onClick={onToggleMobileMenu}
          aria-label="Toggle navigation"
          aria-expanded={mobileMenuOpen}
        >
          {mobileMenuOpen ? <X size={21} /> : <Menu size={21} />}
        </button>
      </div>
    </header>
  )
}
