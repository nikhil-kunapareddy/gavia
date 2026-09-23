import { Component, type ErrorInfo, type ReactNode } from 'react'

interface ErrorBoundaryProps {
  children: ReactNode
}

interface ErrorBoundaryState {
  hasError: boolean
}

/**
 * Catches render-phase errors so a single bad result cannot blank the page.
 *
 * Must be a class component: React exposes no hook equivalent of
 * componentDidCatch / getDerivedStateFromError.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false }

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true }
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error('Unhandled render error:', error, errorInfo.componentStack)
  }

  private handleReload = (): void => {
    window.location.reload()
  }

  render(): ReactNode {
    if (!this.state.hasError) return this.props.children

    return (
      <div className="app-shell">
        <main className="main-content">
          <div className="empty-history">
            <h2>Something went wrong</h2>
            <p>The page ran into an unexpected problem. Reloading usually fixes it.</p>
            <button className="button button-dark" onClick={this.handleReload}>
              Reload the page
            </button>
          </div>
        </main>
      </div>
    )
  }
}
